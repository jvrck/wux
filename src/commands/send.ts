import { appendEvent } from "../runtime/events";
import { currentOwner } from "../runtime/owner";
import { assertOwner, requireLiveRun } from "../runtime/runs";
import { capturePane, connectionForMeta, sendLiteral, type EnterDisposition, type ResendDisposition, type Submission } from "../runtime/tmux";

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
  enter: EnterDisposition;
  resend: ResendDisposition;
  retried: boolean;
}

// A forwarded older/malformed remote can report the established envelope without
// the later decision fields. Keep that absence explicit rather than guessing from
// `retried`; local sends always use the narrower SendResult contract above.
export interface ReportedSendResult extends Omit<SendResult, "enter" | "resend"> {
  enter: EnterDisposition | null;
  resend: ResendDisposition | null;
}

export function enterDispositionText(enter: EnterDisposition | null): string {
  switch (enter) {
    case "sent":
      return "Enter sent";
    case "withheld-busy":
      return "Enter withheld: pane busy";
    case "withheld-busy-queueable":
      return "Enter withheld: pane busy (Tab can queue)";
    case null:
      return "Enter not reported by remote";
  }
}

export function resendDispositionText(resend: ResendDisposition | null): string {
  switch (resend) {
    case "sent":
      return "resend sent";
    case "skipped-busy":
      return "resend skipped: pane busy";
    case "skipped-unknown":
      return "resend skipped: pane state unknown";
    case "not-needed":
      return "resend not needed";
    case null:
      return "resend not reported by remote";
  }
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
  await appendEvent(meta.name, { type: "send", bytes, submission: submit.submission, enter: submit.enter, resend: submit.resend, retried: submit.retried, by: options.actor ?? currentOwner() });
  return { name: meta.name, bytes, submission: submit.submission, enter: submit.enter, resend: submit.resend, retried: submit.retried };
}
