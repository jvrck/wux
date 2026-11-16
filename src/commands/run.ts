import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backendCommand } from "../backends";
import { appendEvent } from "../runtime/events";
import { WuxError } from "../runtime/errors";
import { createRunMeta, saveRun, type RunBackend } from "../runtime/runs";
import { runDir, runsRoot } from "../runtime/state";
import {
  ambientTmuxConnection,
  createSession,
  discoverSocketPath,
  hasSession,
  killSession,
  paneDeadStatus,
  setRemainOnExit,
  stripAnsi,
} from "../runtime/tmux";

export type { RunBackend } from "../runtime/runs";

export interface RunOptions {
  backend: RunBackend;
  name: string;
  cwd: string;
  owner?: string;
  env?: NodeJS.ProcessEnv;
  // Operator args after `--`; passed through to the backend verbatim.
  backendArgs?: string[];
}

export interface RunResult {
  name: string;
  backend: RunBackend;
  tmuxSession: string;
  cwd: string;
  runDir: string;
}

// A short, fixed post-start observation catches a backend that opens a modal or
// otherwise exits immediately after tmux reports the session created. It is a
// one-shot check inside `run`, not a watcher.
const CLAUDE_STARTUP_CHECK_MS = 500;
const STARTUP_PANE_TAIL_LINES = 20;

export async function runCommand(options: RunOptions): Promise<RunResult> {
  const cwd = resolve(options.cwd);
  const backendArgs = options.backendArgs ?? [];
  const command = await backendCommand(options.backend, options.env, backendHooks(options.backend, options.name, options.env), backendArgs);
  const meta = await createRunMeta({ name: options.name, backend: options.backend, cwd, owner: options.owner, command, backendArgs });
  const dir = runDir(meta.name);
  // RunOptions.env is historically a partial process-env overlay (tests pass only
  // SHELL, for example). Apply that overlay once so every creation-adjacent tmux
  // command sees the same TMUX/TMUX_TMPDIR selection as new-session.
  const tmuxEnv = options.env ? { ...process.env, ...options.env } : undefined;
  const connection = ambientTmuxConnection({ env: tmuxEnv });
  if (await hasSession(meta.tmuxSession, connection)) {
    throw new WuxError(`tmux session already exists: ${meta.tmuxSession}`);
  }

  try {
    await mkdir(runsRoot(), { recursive: true });
    await mkdir(dir, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WuxError(`run already exists: ${meta.name}`);
    }
    throw error;
  }

  let sessionCreated = false;
  let exitedDuringStartup = false;
  try {
    const paneLog = join(dir, "pane.log");
    const startupGatePath = join(dir, "startup-ready");
    const observeClaudeStartup = meta.backend === "claude" && !isClaudePrintMode(backendArgs);
    await touch(paneLog);
    await touch(join(dir, "events.jsonl"));
    await createSession({
      session: meta.tmuxSession,
      cwd: meta.cwd,
      command,
      logPath: paneLog,
      ...(observeClaudeStartup ? { startupGatePath } : {}),
      env: tmuxEnv,
      connection,
    });
    sessionCreated = true;
    const tmuxSocketPath = await discoverSocketPath(meta.tmuxSession, connection);
    await saveRun({ ...meta, tmuxSocketPath });
    if (observeClaudeStartup) {
      await writeFile(startupGatePath, "ready\n", "utf8");
      await delay(CLAUDE_STARTUP_CHECK_MS);
      const startupExitStatus = async (): Promise<string | undefined> => {
        if (!(await hasSession(meta.tmuxSession, connection))) return "unknown";
        return paneDeadStatus(meta.tmuxSession, connection);
      };
      const reportStartupExit = async (exitStatus: string): Promise<never> => {
        const paneTail = await paneLogTail(paneLog, STARTUP_PANE_TAIL_LINES);
        // Some tmux configurations retain a dead pane. It is still the session we
        // just created, so remove only that inert container after preserving its
        // log evidence; later commands must not mistake it for a live worker.
        if (await hasSession(meta.tmuxSession, connection)) await killSession(meta.tmuxSession, connection);
        const stoppedAt = new Date().toISOString();
        await saveRun({ ...meta, tmuxSocketPath, status: "stopped", stoppedAt, updatedAt: stoppedAt });
        await appendEvent(meta.name, {
          type: "create",
          backend: meta.backend,
          owner: meta.owner,
          result: "exited-during-startup",
          exitStatus,
          paneTail,
        });
        exitedDuringStartup = true;
        throw new WuxError(`exited-during-startup: ${meta.name}; pane tail:\n${paneTail || "(no pane output captured)"}`);
      };
      const exitStatus = await startupExitStatus();
      if (exitStatus !== undefined) await reportStartupExit(exitStatus);
      await setRemainOnExit(meta.tmuxSession, false, connection);
      // A Claude exit racing with the option change can otherwise leave a dead
      // retained pane that status mistakes for a live worker.
      const exitAfterRemainOff = await startupExitStatus();
      if (exitAfterRemainOff !== undefined) await reportStartupExit(exitAfterRemainOff);
    }
    await appendEvent(meta.name, { type: "create", backend: meta.backend, owner: meta.owner });
  } catch (error) {
    if (exitedDuringStartup) throw error;
    const rollbackErrors: unknown[] = [];
    if (sessionCreated) {
      try {
        await killSession(meta.tmuxSession, connection);
      } catch (rollbackFailure) {
        rollbackErrors.push(rollbackFailure);
      }
    }
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (rollbackFailure) {
      rollbackErrors.push(rollbackFailure);
    }
    if (rollbackErrors.length > 0) {
      throw new WuxError(`${errorMessage(error)}; rollback failed: ${rollbackErrors.map(errorMessage).join("; ")}`);
    }
    throw error;
  }

  return { name: meta.name, backend: meta.backend, tmuxSession: meta.tmuxSession, cwd: meta.cwd, runDir: dir };
}

function isClaudePrintMode(backendArgs: string[]): boolean {
  // Claude's help documents boolean `-p, --print`, not `--print=<value>` or
  // bundled short flags. Stop at `--`: everything after it is backend input.
  for (const arg of backendArgs) {
    if (arg === "--") return false;
    if (arg === "--print" || arg === "-p") return true;
  }
  return false;
}

async function paneLogTail(path: string, lines: number): Promise<string> {
  try {
    const raw = await readFile(path, "utf8");
    return stripAnsi(raw)
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-lines)
      .join("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function touch(path: string): Promise<void> {
  const handle = await open(path, "a");
  await handle.close();
}

function backendHooks(backend: RunBackend, runName: string, env: NodeJS.ProcessEnv = process.env): { notifyCommand?: string[] } {
  // Grok has no verified per-run hook injection (see backends/grok.ts). Do not
  // mutate global or project Grok config to manufacture one.
  if (backend === "shell" || backend === "grok") return {};
  return { notifyCommand: notifyCommand(runName, env) };
}

function notifyCommand(runName: string, env: NodeJS.ProcessEnv): string[] {
  if (env.WUX_NOTIFY_PATH && env.WUX_NOTIFY_PATH.length > 0) {
    return [resolve(env.WUX_NOTIFY_PATH), runName];
  }

  const sourceHelper = fileURLToPath(new URL("../bin/wux-notify.ts", import.meta.url));
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (entry.endsWith("src/index.ts")) {
    return [process.execPath, sourceHelper, runName];
  }
  return [process.execPath, "notify", runName];
}
