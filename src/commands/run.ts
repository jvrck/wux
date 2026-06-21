import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backendCommand } from "../backends";
import { appendEvent } from "../runtime/events";
import { WuxError } from "../runtime/errors";
import { createRunMeta, saveRun, type RunBackend } from "../runtime/runs";
import { runDir, runsRoot } from "../runtime/state";
import { createSession, hasSession, killSession } from "../runtime/tmux";

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

export async function runCommand(options: RunOptions): Promise<RunResult> {
  const cwd = resolve(options.cwd);
  const backendArgs = options.backendArgs ?? [];
  const command = await backendCommand(options.backend, options.env, backendHooks(options.backend, options.name, options.env), backendArgs);
  const meta = await createRunMeta({ name: options.name, backend: options.backend, cwd, owner: options.owner, command, backendArgs });
  const dir = runDir(meta.name);
  if (await hasSession(meta.tmuxSession)) {
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
  try {
    const paneLog = join(dir, "pane.log");
    await touch(paneLog);
    await touch(join(dir, "events.jsonl"));
    await createSession({ session: meta.tmuxSession, cwd: meta.cwd, command, logPath: paneLog, env: options.env });
    sessionCreated = true;
    await saveRun(meta);
    await appendEvent(meta.name, { type: "create", backend: meta.backend, owner: meta.owner });
  } catch (error) {
    if (sessionCreated && (await hasSession(meta.tmuxSession))) {
      await killSession(meta.tmuxSession).catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return { name: meta.name, backend: meta.backend, tmuxSession: meta.tmuxSession, cwd: meta.cwd, runDir: dir };
}

async function touch(path: string): Promise<void> {
  const handle = await open(path, "a");
  await handle.close();
}

function backendHooks(backend: RunBackend, runName: string, env: NodeJS.ProcessEnv = process.env): { notifyCommand?: string[] } {
  if (backend === "shell") return {};
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
