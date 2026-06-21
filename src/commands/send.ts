import { appendEvent } from "../runtime/events";
import { currentOwner } from "../runtime/owner";
import { assertOwner, requireLiveRun } from "../runtime/runs";
import { sendLiteral, type Submission } from "../runtime/tmux";

export interface SendOptions {
  name: string;
  text: string;
  forceOwner: boolean;
  // Mutation-event actor (`by`); defaults to the CLI owner. The MCP layer passes
  // the connected client id (`mcp:<name>`); CLI callers omit it.
  actor?: string;
}

export interface SendResult {
  name: string;
  bytes: number;
  submission: Submission;
  retried: boolean;
}

export async function sendCommand(options: SendOptions): Promise<SendResult> {
  const meta = await requireLiveRun(options.name);
  await assertOwner(meta, options.forceOwner);
  const submit = await sendLiteral(meta.tmuxSession, options.text, { backend: meta.backend });
  const bytes = Buffer.byteLength(options.text);
  await appendEvent(meta.name, { type: "send", bytes, submission: submit.submission, retried: submit.retried, by: options.actor ?? currentOwner() });
  return { name: meta.name, bytes, submission: submit.submission, retried: submit.retried };
}
