import { spawn } from "node:child_process";
import { basename } from "node:path";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runProcess(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command, commandArgs, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolve({ code: code ?? 1, stdout, stderr });
    });

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGTERM");
          child.kill("SIGKILL");
        } catch {
          // ignore — best effort termination (e.g. child already exited)
        }
        const marker = `wux: command timed out after ${options.timeoutMs}ms`;
        const timeoutStderr = stderr.length > 0 ? `${stderr}\n${marker}` : `${marker}\n`;
        resolve({ code: 124, stdout, stderr: timeoutStderr });
      }, options.timeoutMs);
    }
  });
}

// Interactive sibling of runProcess: inherits the parent's stdio so a full-screen
// TUI (tmux attach, locally or forwarded over `ssh -tt`) passes straight through.
// No capture and no timeout — the live session bounds its own lifecycle.
export function runInteractiveProcess(args: string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command, commandArgs, { stdio: "inherit" });
    let settled = false;

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ code: 127, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, stdout: "", stderr: "" });
    });
  });
}

// Best-effort executable basename for a pid, normalized across platforms. macOS
// `ps -o comm=` returns a full path (`/bin/zsh`); Linux returns the bare name or
// path. Taking the basename collapses both to `zsh`, which matches tmux's
// `#{pane_current_command}` form. Returns undefined when the pid is gone or `ps`
// is unavailable — callers must treat that as "unknown", never as a hard state.
export async function processCommandName(
  pid: number,
  runner: (args: string[]) => Promise<ProcessResult> = runProcess,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const result = await runner(["ps", "-o", "comm=", "-p", String(pid)]);
  if (result.code !== 0) return undefined;
  const raw = result.stdout.split("\n")[0]?.trim();
  if (!raw) return undefined;
  return basename(raw);
}
