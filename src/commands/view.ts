import { join } from "node:path";
import { lastInput } from "../runtime/events";
import { loadRun } from "../runtime/runs";
import { runDir } from "../runtime/state";

export interface ViewOptions {
  name: string;
}

// How to watch a run live (visibility only — no control). The MCP `view` tool and
// any CLI caller compose this; it never mutates and never touches tmux directly.
export interface ViewResult {
  name: string;
  tmuxSession: string;
  // Exact socket persisted at creation; absent only for legacy metadata.
  tmuxSocketPath?: string;
  // Stable exact tmux target; callers may keep using it as `tmux attach -t "$target"`.
  tmuxTarget: string;
  // Socket-qualified, POSIX-shell-safe attach command for current metadata.
  tmuxCommand?: string;
  runDir: string;
  paneLogPath: string;
  lastInputBy?: string | null;
  lastInputAt?: string | null;
}

export async function viewCommand(options: ViewOptions): Promise<ViewResult> {
  const meta = await loadRun(options.name);
  const dir = runDir(meta.name);
  const input = await lastInput(meta.name);
  return {
    name: meta.name,
    tmuxSession: meta.tmuxSession,
    ...(meta.tmuxSocketPath !== undefined ? { tmuxSocketPath: meta.tmuxSocketPath } : {}),
    tmuxTarget: `=${meta.tmuxSession}:`,
    ...(meta.tmuxSocketPath !== undefined
      ? { tmuxCommand: `tmux -S ${shellQuote(meta.tmuxSocketPath)} attach-session -t ${shellQuote(`=${meta.tmuxSession}`)}` }
      : {}),
    runDir: dir,
    paneLogPath: join(dir, "pane.log"),
    lastInputBy: input.lastInputBy,
    lastInputAt: input.lastInputAt,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
