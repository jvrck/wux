import { appendEvent } from "../runtime/events";
import { currentOwner } from "../runtime/owner";
import { assertOwner, requireLiveRun } from "../runtime/runs";
import { interruptSession } from "../runtime/tmux";

export interface InterruptOptions {
  name: string;
  forceOwner: boolean;
  // Mutation-event actor (`by`); defaults to the CLI owner. The MCP layer passes
  // the connected client id (`mcp:<name>`); CLI callers omit it.
  actor?: string;
}

export interface InterruptResult {
  name: string;
  interrupted: true;
}

// Interrupt a live run's current turn with a single C-c. Mirrors sendCommand's
// guards (live + ownership); it is a named control, not an arbitrary-key API.
export async function interruptCommand(options: InterruptOptions): Promise<InterruptResult> {
  const meta = await requireLiveRun(options.name);
  await assertOwner(meta, options.forceOwner);
  await interruptSession(meta.tmuxSession);
  await appendEvent(meta.name, { type: "interrupt", by: options.actor ?? currentOwner() });
  return { name: meta.name, interrupted: true };
}
