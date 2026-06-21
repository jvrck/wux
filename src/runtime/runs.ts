import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WuxError } from "./errors";
import { appendEvent } from "./events";
import { currentOwner } from "./owner";
import { runDir, runsRoot } from "./state";
import { hasSession, tmuxSessionName } from "./tmux";

export type RunBackend = "shell" | "claude" | "codex";
export type RunStatus = "running" | "waiting" | "blocked" | "stopped";
export type MarkStatus = RunStatus;

export interface RunMeta {
  name: string;
  backend: RunBackend;
  tmuxSession: string;
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
  const dir = runDir(meta.name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}
`, "utf8");
}

export async function loadRun(name: string): Promise<RunMeta> {
  validateRunName(name);
  try {
    const raw = await readFile(join(runDir(name), "meta.json"), "utf8");
    return JSON.parse(raw) as RunMeta;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WuxError(`run not found: ${name}`);
    }
    throw error;
  }
}

export async function listRuns(): Promise<RunMeta[]> {
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
      runs.push(await loadRun(entry.name));
    } catch (error) {
      if (error instanceof WuxError || error instanceof SyntaxError) continue;
      throw error;
    }
  }

  return runs.sort((left, right) => left.name.localeCompare(right.name));
}

export async function markRun(name: string, status: MarkStatus): Promise<RunMeta> {
  const meta = await loadRun(name);
  const live = await hasSession(meta.tmuxSession);
  if (status === "stopped" && live) {
    throw new WuxError(`tmux session is still running for ${name}: ${meta.tmuxSession}`);
  }
  if (status !== "stopped" && !live) {
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
  if (!(await hasSession(meta.tmuxSession))) {
    throw new WuxError(`tmux session is not running for ${name}: ${meta.tmuxSession}`);
  }
  return meta;
}
