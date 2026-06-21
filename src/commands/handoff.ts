import { readFile } from "node:fs/promises";
import { readRun } from "./read";
import { sendCommand } from "./send";
import { type WaitResult, waitCommand } from "./wait";
import { appendEvent } from "../runtime/events";
import { WuxError } from "../runtime/errors";
import { DEFAULT_HANDOFF_PROMPT, DEFAULT_HANDOFF_TAIL, DEFAULT_HANDOFF_WAIT_MS } from "../runtime/prompts";

export interface HandoffOptions {
  name: string;
  promptFile?: string;
  waitMs?: number;
  tail?: number;
  // Settle-on-ladder seam. Defaults to `wux wait`'s completion ladder
  // (hook > sentinel > quiescence) bounded by `waitMs` as a timeout. Injectable
  // so tests can assert handoff settles before it reads.
  wait?: (timeoutMs: number) => Promise<WaitResult>;
}

export async function handoffRun(options: HandoffOptions): Promise<string> {
  if (!options.name) throw new WuxError("handoff requires <run-name>");
  const waitMs = options.waitMs ?? DEFAULT_HANDOFF_WAIT_MS;
  const tail = options.tail ?? DEFAULT_HANDOFF_TAIL;
  validateHandoffTiming(waitMs, tail);

  const prompt = await loadHandoffPrompt(options.promptFile);
  await sendCommand({ name: options.name, text: prompt, forceOwner: false });

  // Settle on the completion ladder instead of a fixed sleep: `--wait-ms` is an
  // upper bound, not a guaranteed pause. The worker's turn usually completes
  // (hook/sentinel/quiescence) well before the timeout, so `read` captures the
  // finished structured summary rather than a half-rendered `Working` frame.
  // `--wait-ms 0` means "do not wait" — read the pane immediately.
  const settled = waitMs === 0 ? undefined : await settle(options, waitMs);
  const output = await readRun({ name: options.name, tail });
  await appendEvent(options.name, {
    type: "handoff",
    promptSource: options.promptFile ? "file" : "default",
    promptBytes: Buffer.byteLength(prompt),
    waitMs,
    tail,
    waitOutcome: settled?.outcome ?? "skipped",
    settledVia: settled?.completedVia ?? null,
    waitedMs: settled?.waitedMs ?? 0,
  });
  return output;
}

export async function handoffCommand(options: HandoffOptions): Promise<void> {
  process.stdout.write(await handoffRun(options));
}

export async function loadHandoffPrompt(promptFile?: string): Promise<string> {
  const prompt = promptFile ? await readFile(promptFile, "utf8") : DEFAULT_HANDOFF_PROMPT;
  if (prompt.length === 0) {
    throw new WuxError("handoff prompt is empty");
  }
  return prompt;
}

// Bound the completion ladder by `waitMs` as a hard timeout. `wait` returns on
// the first of hook/sentinel/quiescence or timeout, so handoff never blocks past
// `waitMs` regardless of which rung resolves (or none does).
async function settle(options: HandoffOptions, waitMs: number): Promise<WaitResult> {
  const wait = options.wait ?? ((timeoutMs: number) => waitCommand({ name: options.name, timeoutMs }));
  return wait(waitMs);
}

function validateHandoffTiming(waitMs: number, tail: number): void {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    throw new WuxError("--wait-ms must be a non-negative integer");
  }
  if (!Number.isSafeInteger(tail) || tail <= 0) {
    throw new WuxError("--tail must be a positive integer");
  }
}
