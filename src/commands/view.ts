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
  // tmux pane target for `tmux attach -t ...` (exact-match form).
  tmuxTarget: string;
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
    tmuxTarget: `=${meta.tmuxSession}:`,
    runDir: dir,
    paneLogPath: join(dir, "pane.log"),
    lastInputBy: input.lastInputBy,
    lastInputAt: input.lastInputAt,
  };
}
