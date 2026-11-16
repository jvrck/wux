import { appendEvent, inputMessageDigest } from "../runtime/events";
import { currentOwner } from "../runtime/owner";
import { assertOwner, requireLiveRun } from "../runtime/runs";
import { capturePane, connectionForMeta, sendLiteral, type Submission } from "../runtime/tmux";

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
  const connection = connectionForMeta(meta);
  const bytes = Buffer.byteLength(options.text);
  const by = options.actor ?? currentOwner();
  // Codex can notify as soon as its pane receives input. Persist the turn
  // discriminator before typing so that hook is never ordered before its own
  // current turn. Keep this record if delivery later fails or is withheld.
  if (meta.backend === "codex") {
    await appendEvent(meta.name, {
      type: "send",
      phase: "started",
      bytes,
      inputMessageDigest: inputMessageDigest(options.text),
      by,
    });
  }
  const submit = await sendLiteral(meta.tmuxSession, options.text, {
    backend: meta.backend,
    connection,
    capture: (session, tail) => capturePane(session, tail, connection),
  });
  await appendEvent(meta.name, {
    type: "send",
    ...(meta.backend === "codex" ? { phase: "result" } : {}),
    bytes,
    submission: submit.submission,
    retried: submit.retried,
    ...(meta.backend === "codex" ? { inputMessageDigest: inputMessageDigest(options.text) } : {}),
    by,
  });
  return { name: meta.name, bytes, submission: submit.submission, retried: submit.retried };
}
