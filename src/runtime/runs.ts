import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WuxError } from "./errors";
import { appendEvent } from "./events";
import { currentOwner } from "./owner";
import { runDir, runsRoot } from "./state";
import { connectionForMeta, probeSession, tmuxSessionName, unavailableTmuxMessage } from "./tmux";

export type RunBackend = "shell" | "claude" | "codex" | "grok";
export type RunStatus = "running" | "waiting" | "blocked" | "stopped";
export type MarkStatus = RunStatus;

export interface RunMeta {
  name: string;
  backend: RunBackend;
  tmuxSession: string;
  // Present for every run created by current Wux. Omitted only by legacy state.
  tmuxSocketPath?: string;
  cwd: string;
  owner: string;
  createdAt: string;
  command?: string[];
  // Operator passthrough args (after `--`); recorded for launch provenance.
  backendArgs?: string[];
  status: RunStatus;
  updatedAt?: string;
  stoppedAt?: string;
}

const RUN_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function validateRunName(name: string): void {
  if (!RUN_NAME_RE.test(name) || name === "." || name === "..") {
    throw new WuxError(`invalid run name '${name}'; use letters, numbers, dot, underscore, or dash`);
  }
}

export async function createRunMeta(input: {
  name: string;
  backend: RunBackend;
  cwd: string;
  owner?: string;
  command?: string[];
  backendArgs?: string[];
}): Promise<RunMeta> {
  validateRunName(input.name);
  try {
    await stat(runDir(input.name));
    throw new WuxError(`run already exists: ${input.name}`);
  } catch (error) {
    if (error instanceof WuxError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return {
    name: input.name,
    backend: input.backend,
    tmuxSession: tmuxSessionName(input.name),
    cwd: input.cwd,
    owner: input.owner ?? currentOwner(),
    createdAt: new Date().toISOString(),
    command: input.command,
    // Omit when no passthrough was given so no-`--` meta stays byte-identical.
    ...(input.backendArgs && input.backendArgs.length > 0 ? { backendArgs: input.backendArgs } : {}),
    status: "running",
  };
}

export async function saveRun(meta: RunMeta): Promise<void> {
  validateRunName(meta.name);
  connectionForMeta(meta);
  const dir = runDir(meta.name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}
`, "utf8");
}

export async function loadRun(name: string): Promise<RunMeta> {
  validateRunName(name);
  try {
    const raw = await readFile(join(runDir(name), "meta.json"), "utf8");
    const meta = JSON.parse(raw) as RunMeta;
    connectionForMeta(meta);
    return meta;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WuxError(`run not found: ${name}`);
    }
    throw error;
  }
}

export async function listRuns(): Promise<RunMeta[]> {
  return readRunMetadata(true);
}

// Status JSON deliberately permits an invalid stored socket through to its
// per-run error handling, where it becomes `unavailable`. All other metadata
// fields still need to be structurally sound before any command consumes them.
export async function listRunMetadata(): Promise<RunMeta[]> {
  return readRunMetadata(false);
}

async function readRunMetadata(validateSocket: boolean): Promise<RunMeta[]> {
  let entries;
  try {
    entries = await readdir(runsRoot(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const runs: RunMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(join(runsRoot(), entry.name, "meta.json"), "utf8");
      const meta = JSON.parse(raw);
      if (!isRunMeta(meta) || meta.name !== entry.name) continue;
      if (validateSocket) connectionForMeta(meta);
      runs.push(meta);
    } catch (error) {
      if (error instanceof WuxError || error instanceof SyntaxError) continue;
      throw error;
    }
  }

  return runs.sort((left, right) => left.name.localeCompare(right.name));
}

function isRunMeta(value: unknown): value is RunMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Record<string, unknown>;
  if (
    typeof meta.name !== "string" ||
    !isValidRunName(meta.name) ||
    typeof meta.tmuxSession !== "string" ||
    typeof meta.cwd !== "string" ||
    typeof meta.owner !== "string" ||
    typeof meta.createdAt !== "string" ||
    !["shell", "claude", "codex", "grok"].includes(meta.backend as string) ||
    !["running", "waiting", "blocked", "stopped"].includes(meta.status as string)
  ) return false;
  return (meta.command === undefined || isStringArray(meta.command)) && (meta.backendArgs === undefined || isStringArray(meta.backendArgs));
}

function isValidRunName(name: string): boolean {
  return RUN_NAME_RE.test(name) && name !== "." && name !== "..";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export async function markRun(name: string, status: MarkStatus): Promise<RunMeta> {
  const meta = await loadRun(name);
  const connection = connectionForMeta(meta);
  const probe = await probeSession(meta.tmuxSession, connection);
  if (probe.state === "unavailable") {
    throw new WuxError(`${unavailableTmuxMessage(connection, probe.detail)} for ${name}`);
  }
  if (status === "stopped" && probe.state === "live") {
    throw new WuxError(`tmux session is still running for ${name}: ${meta.tmuxSession}`);
  }
  if (status !== "stopped" && probe.state !== "live") {
    throw new WuxError(`tmux session is not running for ${name}: ${meta.tmuxSession}`);
  }
  const next = { ...meta, status, updatedAt: new Date().toISOString() };
  await saveRun(next);
  try {
    await appendEvent(name, { type: "mark", status });
  } catch (error) {
    await saveRun(meta).catch(() => undefined);
    throw error;
  }
  return next;
}

export async function assertOwner(meta: RunMeta, forceOwner: boolean): Promise<void> {
  const owner = currentOwner();
  if (!forceOwner && meta.owner !== owner) {
    throw new WuxError(`run ${meta.name} is owned by ${meta.owner}; use --force-owner to send anyway`);
  }
}

export async function finalizeStopped(meta: RunMeta, by: string): Promise<RunMeta> {
  const stoppedAt = new Date().toISOString();
  const stopped: RunMeta = { ...meta, status: "stopped", stoppedAt, updatedAt: stoppedAt };
  await saveRun(stopped);
  try {
    await appendEvent(meta.name, { type: "stop", stoppedAt, by });
  } catch (error) {
    await saveRun(meta).catch(() => undefined);
    throw error;
  }
  return stopped;
}

export async function requireLiveRun(name: string): Promise<RunMeta> {
  const meta = await loadRun(name);
  if (meta.status === "stopped") {
    throw new WuxError(`run is stopped: ${name}`);
  }
  const connection = connectionForMeta(meta);
  const probe = await probeSession(meta.tmuxSession, connection);
  if (probe.state === "unavailable") {
    throw new WuxError(`${unavailableTmuxMessage(connection, probe.detail)} for ${name}`);
  }
  if (probe.state !== "live") {
    throw new WuxError(`tmux session is not running for ${name}: ${meta.tmuxSession}`);
  }
  return meta;
}
