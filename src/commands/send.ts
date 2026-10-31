import { appendEvent, inputMessageDigest, normalizeCodexInput, readLatestBackendSignal } from "../runtime/events";
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
  const submit = await sendLiteral(meta.tmuxSession, options.text, {
    backend: meta.backend,
    connection,
    capture: (session, tail) => capturePane(session, tail, connection),
  });
  const bytes = Buffer.byteLength(options.text);
  const latestSignal = meta.backend === "codex" ? await readLatestBackendSignal(meta.name) : undefined;
  const previousInputMessagesCount = latestSignal?.inputMessagesCount;
  const expectedInputMessagesCount =
    previousInputMessagesCount !== undefined && Number.isSafeInteger(previousInputMessagesCount) ? previousInputMessagesCount + 1 : undefined;
  await appendEvent(meta.name, {
    type: "send",
    bytes,
    submission: submit.submission,
    retried: submit.retried,
    inputMessageDigest: inputMessageDigest(normalizeCodexInput(options.text)),
    ...(expectedInputMessagesCount !== undefined ? { expectedInputMessagesCount } : {}),
    by: options.actor ?? currentOwner(),
  });
  return { name: meta.name, bytes, submission: submit.submission, retried: submit.retried };
}
