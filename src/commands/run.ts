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
  ambientSocketPath,
  createSession,
  discoverSocketPath,
  hasSession,
  killSession,
  paneDeadStatus,
  probeSession,
  recordCreatedSocket,
  removeCreatedSocket,
  setRemainOnExit,
  socketTmuxConnection,
  unavailableTmuxMessage,
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

// A one-shot observation, not a watcher: it catches the trust-dialog exit
// immediately after the backend starts without changing later run lifecycle.
const CLAUDE_STARTUP_CHECK_MS = 500;
const STARTUP_PANE_TAIL_LINES = 20;
const STARTUP_GATE_TIMEOUT = "wux: startup gate timed out waiting for readiness file";
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_EXCEPT_NEWLINE_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

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
  const expectedAmbientSocketPath = await ambientSocketPath(tmuxEnv);
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
  let startupExitReported = false;
  let startupObservationUnavailable = false;
  let launchFailureReported = false;
  let launchExitFinalized = false;
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
      // Hold every backend until per-session options and logging are ready.
      // This makes a short-lived pane observable without changing any global
      // tmux setting or creating a watcher.
      startupGatePath,
      env: tmuxEnv,
      connection,
    });
    sessionCreated = true;
    const tmuxSocketPath = await discoverSocketPath(meta.tmuxSession, connection);
    await saveRun({ ...meta, tmuxSocketPath });
    const startupConnection = socketTmuxConnection(tmuxSocketPath, { executable: connection.executable, env: tmuxEnv });
    const createdSocket = await recordCreatedSocket(meta.tmuxSession, tmuxSocketPath, expectedAmbientSocketPath, startupConnection);
    await writeFile(startupGatePath, "ready\n", "utf8");
    if (observeClaudeStartup) {
      // Startup observation must follow the exact server that created this run.
      // An ambient connection maps a transport failure to "absent", which would
      // falsely claim a live backend exited; a socket-bound probe preserves the
      // authoritative unavailable state instead.
      await delay(CLAUDE_STARTUP_CHECK_MS);
      const reportUnavailable = (detail: string | undefined): never => {
        startupObservationUnavailable = true;
        throw new WuxError(unavailableTmuxMessage(startupConnection, detail));
      };

      const startupState = async (): Promise<string | undefined> => {
        const probe = await probeSession(meta.tmuxSession, startupConnection);
        if (probe.state === "unavailable") return reportUnavailable(probe.detail);
        if (probe.state === "absent") return "unknown";
        const pane = await paneDeadStatus(meta.tmuxSession, startupConnection);
        if (pane.state === "dead") return pane.exitStatus;
        if (pane.state === "live") return undefined;

        // The pane query itself could not establish liveness. Re-probe once to
        // distinguish a confirmed disappearance from a transport failure.
        const retry = await probeSession(meta.tmuxSession, startupConnection);
        if (retry.state === "absent") return "unknown";
        if (retry.state === "unavailable") return reportUnavailable(retry.detail);
        return reportUnavailable(pane.detail);
      };
      const reportStartupExit = async (exitStatus: string): Promise<never> => {
        const paneTail = await paneLogTail(paneLog, STARTUP_PANE_TAIL_LINES);
        if ((await exists(`${startupGatePath}.timed-out`)) || paneTail.includes(STARTUP_GATE_TIMEOUT)) {
          throw new WuxError("startup gate timed out before claude launch; retry the run");
        }
        const probe = await probeSession(meta.tmuxSession, startupConnection);
        if (probe.state === "unavailable") return reportUnavailable(probe.detail);
        if (probe.state === "live") {
          try {
            await killSession(meta.tmuxSession, startupConnection);
          } catch (error) {
            return reportUnavailable(errorMessage(error));
          }
        }
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
        startupExitReported = true;
        throw new WuxError(`exited-during-startup: ${meta.name}; pane tail:\n${paneTail || "(no pane output captured)"}`);
      };

      const exitStatus = await startupState();
      if (exitStatus !== undefined) await reportStartupExit(exitStatus);
      try {
        await setRemainOnExit(meta.tmuxSession, false, startupConnection);
      } catch (error) {
        return reportUnavailable(errorMessage(error));
      }
      // A process can exit while remain-on-exit is being toggled. Check once more
      // so an inert retained pane cannot be returned as a live worker.
      const exitAfterToggle = await startupState();
      if (exitAfterToggle !== undefined) await reportStartupExit(exitAfterToggle);
    } else {
      // Yield once after opening the gate so an immediate command exit is still
      // inside launch. This is deliberately a one-shot observation, not a
      // lifecycle watcher or retry loop.
      await delay(25);
      const launchExit = await launchExitStatus(meta.tmuxSession, startupConnection);
      if (launchExit !== undefined) {
        if (launchExit === "0") {
          await reportLaunchSuccess(launchExit);
        } else {
          await reportLaunchFailure(launchExit);
        }
      }
      if (!launchExitFinalized) {
        await setRemainOnExit(meta.tmuxSession, false, startupConnection);
        const exitAfterToggle = await launchExitStatus(meta.tmuxSession, startupConnection);
        if (exitAfterToggle !== undefined) {
          if (exitAfterToggle === "0") {
            await reportLaunchSuccess(exitAfterToggle);
          } else {
            await reportLaunchFailure(exitAfterToggle);
          }
        }
      }
    }
    if (!launchExitFinalized) {
      await appendEvent(meta.name, { type: "create", backend: meta.backend, owner: meta.owner });
    }

    async function launchExitStatus(session: string, launchConnection: ReturnType<typeof socketTmuxConnection>): Promise<string | undefined> {
      const pane = await paneDeadStatus(session, launchConnection);
      if (pane.state === "dead") return pane.exitStatus;
      if (pane.state === "live") return undefined;
      const probe = await probeSession(session, launchConnection);
      if (probe.state === "absent") return "unknown";
      throw new WuxError(unavailableTmuxMessage(launchConnection, probe.detail ?? pane.detail));
    }

    async function reportLaunchSuccess(exitStatus: string): Promise<void> {
      const paneTail = await paneLogTail(paneLog, STARTUP_PANE_TAIL_LINES);
      const probe = await probeSession(meta.tmuxSession, startupConnection);
      if (probe.state === "unavailable") {
        throw new WuxError(unavailableTmuxMessage(startupConnection, probe.detail));
      }
      if (probe.state === "live") {
        try {
          await killSession(meta.tmuxSession, startupConnection);
        } catch (error) {
          const afterKill = await probeSession(meta.tmuxSession, startupConnection);
          if (afterKill.state === "live") throw error;
          if (afterKill.state === "unavailable") {
            throw new WuxError(unavailableTmuxMessage(startupConnection, afterKill.detail));
          }
        }
      }
      const stoppedAt = new Date().toISOString();
      await saveRun({ ...meta, tmuxSocketPath, status: "stopped", stoppedAt, updatedAt: stoppedAt });
      await appendEvent(meta.name, {
        type: "create",
        backend: meta.backend,
        owner: meta.owner,
        result: "exited-during-launch",
        exitStatus,
        paneTail,
      });
      launchExitFinalized = true;
    }

    async function reportLaunchFailure(exitStatus: string): Promise<never> {
      const paneTail = await paneLogTail(paneLog, STARTUP_PANE_TAIL_LINES);
      const probe = await probeSession(meta.tmuxSession, startupConnection);
      if (probe.state === "unavailable") {
        throw new WuxError(unavailableTmuxMessage(startupConnection, probe.detail));
      }
      if (probe.state === "live") {
        try {
          await killSession(meta.tmuxSession, startupConnection);
        } catch (error) {
          const afterKill = await probeSession(meta.tmuxSession, startupConnection);
          if (afterKill.state === "live") throw error;
          if (afterKill.state === "unavailable") {
            throw new WuxError(unavailableTmuxMessage(startupConnection, afterKill.detail));
          }
        }
      }
      await removeCreatedSocket(createdSocket, startupConnection);
      const failedAt = new Date().toISOString();
      await saveRun({ ...meta, tmuxSocketPath, status: "failed", updatedAt: failedAt });
      await appendEvent(meta.name, {
        type: "launch-error",
        backend: meta.backend,
        owner: meta.owner,
        exitStatus,
        paneTail,
      });
      launchFailureReported = true;
      throw new WuxError(`pane exited (status ${exitStatus}): ${paneTail || "(no pane output captured)"}`);
    }
  } catch (error) {
    if (startupExitReported || startupObservationUnavailable || launchFailureReported) throw error;
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

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isClaudePrintMode(backendArgs: string[]): boolean {
  for (const arg of backendArgs) {
    if (arg === "--") return false;
    if (arg === "--print" || arg === "-p") return true;
  }
  return false;
}

async function paneLogTail(path: string, lines: number): Promise<string> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .replace(ANSI_RE, "")
      .replace(/\x1b/g, "")
      .replace(CONTROL_EXCEPT_NEWLINE_RE, "")
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
