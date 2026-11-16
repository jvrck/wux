import { randomUUID } from "node:crypto";
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
  const sendId = meta.backend === "codex" ? randomUUID() : undefined;
  const digest = meta.backend === "codex" ? inputMessageDigest(options.text) : undefined;
  // Codex can notify as soon as its pane receives input. Persist the turn
  // discriminator before typing so that hook is never ordered before its own
  // current turn. A later result resolves this attempt: only `submitted` turns
  // can authorize the recorded hook.
  if (meta.backend === "codex") {
    await appendEvent(meta.name, {
      type: "send",
      phase: "started",
      sendId,
      bytes,
      inputMessageDigest: digest,
      by,
    });
  }
  try {
    const submit = await sendLiteral(meta.tmuxSession, options.text, {
      backend: meta.backend,
      connection,
      capture: (session, tail) => capturePane(session, tail, connection),
    });
    await appendEvent(meta.name, {
      type: "send",
      ...(meta.backend === "codex" ? { phase: "result", sendId, inputMessageDigest: digest } : {}),
      bytes,
      submission: submit.submission,
      retried: submit.retried,
      by,
    });
    return { name: meta.name, bytes, submission: submit.submission, retried: submit.retried };
  } catch (error) {
    if (meta.backend === "codex") {
      await appendEvent(meta.name, {
        type: "send",
        phase: "result",
        sendId,
        bytes,
        submission: "uncertain",
        delivery: "failed",
        inputMessageDigest: digest,
        by,
      });
    }
    throw error;
  }
}
