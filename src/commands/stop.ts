import { createInterface } from "node:readline/promises";
import { WuxError } from "../runtime/errors";
import { currentOwner } from "../runtime/owner";
import { finalizeStopped, loadRun, type RunMeta } from "../runtime/runs";
import { hasSession, killSession } from "../runtime/tmux";

export type StopConfirm = (meta: RunMeta) => Promise<boolean>;

export interface StopOptions {
  name: string;
  yes: boolean;
  confirm?: StopConfirm;
  inputIsTTY?: boolean;
  // Mutation-event actor (`by`); defaults to the CLI owner. The MCP layer passes
  // the connected client id (`mcp:<name>`); CLI callers omit it.
  actor?: string;
}

export interface StopResult {
  name: string;
  stopped: true;
}

export async function stopRun(options: StopOptions): Promise<RunMeta> {
  if (!options.name) throw new WuxError("stop requires <run-name>");
  const meta = await loadRun(options.name);
  const by = options.actor ?? currentOwner();
  // Idempotent: a run already finalized as `stopped` is in the desired state.
  if (meta.status === "stopped") {
    return meta;
  }

  // Session-agnostic: if the tmux session is already gone (it died, or was killed
  // externally), `stop` is still the one verb that tears the run down. Finalize to
  // `stopped` rather than erroring — the run is already in the desired liveness.
  if (!(await hasSession(meta.tmuxSession))) {
    return finalizeStopped(meta, by);
  }

  if (!options.yes) {
    const inputIsTTY = options.inputIsTTY ?? process.stdin.isTTY;
    if (!options.confirm && !inputIsTTY) {
      throw new WuxError("stop requires confirmation; use --yes for non-interactive stop");
    }
    const confirmed = await (options.confirm ?? promptStop)(meta);
    if (!confirmed) throw new WuxError("stop cancelled");
  }

  await killSession(meta.tmuxSession);
  return finalizeStopped(meta, by);
}

export async function stopCommand(name: string, yes: boolean, actor?: string): Promise<StopResult> {
  const stopped = await stopRun({ name, yes, actor });
  return { name: stopped.name, stopped: true };
}

async function promptStop(meta: RunMeta): Promise<boolean> {
  const answer = await askQuestion(`Stop ${meta.name} (${meta.tmuxSession})? [y/N] `);
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function askQuestion(prompt: string): Promise<string> {
  // Interactive confirm prompt goes to stderr so stdout stays clean (the
  // MCP-stdout invariant); this path is human-TTY only and never runs in MCP mode.
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}
