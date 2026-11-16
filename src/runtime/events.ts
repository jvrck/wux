import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runDir } from "./state";

export interface RunEvent {
  type: string;
  at?: string;
  run?: string;
  // Actor for mutation events (send/interrupt/stop): owner "user@host" for CLI,
  // MCP client id for MCP-originated mutations (stamped by #78). Frozen §3.
  by?: string;
  [key: string]: unknown;
}

export interface LastInput {
  lastInputAt: string | null;
  lastInputBy: string | null;
}

export type BackendSignal = "turn-complete" | "awaiting-approval";

export interface BackendSignalEvent extends RunEvent {
  type: "backend-signal";
  signal?: BackendSignal;
  at: string;
  turnId?: string;
  lastAssistantMessage?: string;
  payloadType?: string;
  threadId?: string;
  client?: string;
  inputMessagesCount?: number;
  inputMessageDigest?: string;
  explicit?: boolean;
}

export interface BackendSignalInput {
  signal?: BackendSignal;
  at?: string;
  turnId?: string;
  lastAssistantMessage?: string;
  payloadType?: string;
  threadId?: string;
  client?: string;
  inputMessagesCount?: number;
  inputMessageDigest?: string;
  // Whether this came from an explicit `wux notify <run> <signal>` operator
  // assertion, rather than payload-derived hook mapping.
  explicit?: boolean;
  // Payload-derived Codex hooks observed while delivery is unresolved are kept
  // as evidence but cannot write a completion sentinel yet.
  writeSentinel?: boolean;
}

export interface BackendSignalObservation {
  signal?: BackendSignalEvent;
  lastTurnInputAt: string | null;
  lastTurnInputDigest?: string;
}

export interface CurrentTurnInput {
  inputMessageDigest?: string;
  ambiguousDuplicate?: boolean;
  eligible?: boolean;
}

// Codex records its final input message with leading and trailing whitespace
// removed. Keep only a digest in run events so hook correlation does not retain
// the operator's prompt.
export function normalizeCodexInput(text: string): string {
  return text.trim();
}

export function inputMessageDigest(message: string): string {
  return createHash("sha256").update(normalizeCodexInput(message)).digest("hex");
}

// Persisted record of a `wait` settle so the read-only `result` snapshot can
// report the same outcome `wait` resolved — including `quiescence`, which a
// single-point snapshot cannot observe. `sinceInputAt` is the `lastTurnInputAt`
// `wait` resolved against; a newer `send`/`interrupt` supersedes the record
// (the new turn is unsettled), mirroring the turn-scoped discipline that filters
// backend signals. Only terminal outcomes worth surfacing are persisted; an
// `unknown` (session gone, no signal) is never written, so a never-`wait`ed or
// only-`unknown` run keeps reporting `unknown` (no fabrication).
export interface WaitSettledEvent extends RunEvent {
  type: "wait-settled";
  outcome: "done" | "timeout" | "blocked";
  completedVia?: "hook" | "sentinel" | "quiescence";
  at: string;
  // The lastTurnInputAt this settle resolved against; null when the run had no
  // prior send/interrupt (e.g. a run waited immediately after launch).
  sinceInputAt: string | null;
}

export interface WaitSettledInput {
  outcome: "done" | "timeout" | "blocked";
  completedVia?: "hook" | "sentinel" | "quiescence";
  at?: string;
  sinceInputAt: string | null;
}

// Mutation events whose actor + timestamp feed `lastInput` (concurrency visibility).
const MUTATION_TYPES = new Set(["send", "interrupt", "stop"]);

export async function appendEvent(runName: string, event: RunEvent): Promise<void> {
  const dir = runDir(runName);
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    ...event,
    type: event.type,
    at: event.at ?? new Date().toISOString(),
    run: event.run ?? runName,
  });
  await appendFile(join(dir, "events.jsonl"), `${line}
`, "utf8");
}

export async function readEvents(runName: string): Promise<RunEvent[]> {
  let raw: string;
  try {
    raw = await readFile(join(runDir(runName), "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: RunEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // Skip malformed lines rather than failing the whole read.
    }
  }
  return events;
}

export async function appendBackendSignal(runName: string, input: BackendSignalInput): Promise<BackendSignalEvent> {
  const at = input.at ?? new Date().toISOString();
  const event: BackendSignalEvent = {
    type: "backend-signal",
    run: runName,
    signal: input.signal,
    at,
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.lastAssistantMessage !== undefined ? { lastAssistantMessage: input.lastAssistantMessage } : {}),
    ...(input.payloadType !== undefined ? { payloadType: input.payloadType } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.client !== undefined ? { client: input.client } : {}),
    ...(input.inputMessagesCount !== undefined ? { inputMessagesCount: input.inputMessagesCount } : {}),
    ...(input.inputMessageDigest !== undefined ? { inputMessageDigest: input.inputMessageDigest } : {}),
    ...(input.explicit === true ? { explicit: true } : {}),
  };
  await appendEvent(runName, event);

  const dir = runDir(runName);
  await mkdir(dir, { recursive: true });
  if (input.signal !== undefined) {
    const state = {
      lastSignal: input.signal,
      at,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.inputMessageDigest !== undefined ? { inputMessageDigest: input.inputMessageDigest } : {}),
      ...(input.explicit === true ? { explicit: true } : {}),
    };
    await writeFile(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}
`, "utf8");
  }
  if (input.signal === "turn-complete" && (input.writeSentinel ?? true)) {
    await writeFile(join(dir, "turn-complete"), `${input.signal} ${at}${input.inputMessageDigest === undefined ? "" : ` ${input.inputMessageDigest}`}
`, "utf8");
  }
  return event;
}

export async function readLatestBackendSignal(runName: string): Promise<BackendSignalEvent | undefined> {
  const events = await readEvents(runName);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isBackendSignalEvent(event)) return event;
  }
  return readBackendSignalState(runName);
}

export async function readBackendSignalObservation(runName: string): Promise<BackendSignalObservation> {
  const events = await readEvents(runName);
  const current = currentTurnInput(events);
  const lastTurnInputIndex = current?.index ?? -1;
  const lastTurnInputAt = current?.at ?? null;
  const lastTurnInputDigest = current?.inputMessageDigest;

  for (let index = events.length - 1; index > lastTurnInputIndex; index -= 1) {
    const event = events[index];
    if (isBackendSignalEvent(event) && (current === undefined || current.eligible || event.explicit === true)) {
      return { signal: event, lastTurnInputAt, ...(lastTurnInputDigest !== undefined ? { lastTurnInputDigest } : {}) };
    }
  }

  const stateSignal = await readBackendSignalState(runName);
  if (stateSignal && (current === undefined || current.eligible || stateSignal.explicit === true) && signalIsAfterLastTurnInput(stateSignal, lastTurnInputAt)) {
    return { signal: stateSignal, lastTurnInputAt, ...(lastTurnInputDigest !== undefined ? { lastTurnInputDigest } : {}) };
  }
  return { lastTurnInputAt, ...(lastTurnInputDigest !== undefined ? { lastTurnInputDigest } : {}) };
}

// Codex can send the same prompt more than once. A matching completion is only
// attributable to the latest send when no earlier identical send remains
// unanswered; an accepted completion resets that ambiguity boundary.
export async function readCurrentTurnInput(runName: string): Promise<CurrentTurnInput> {
  const events = await readEvents(runName);
  const current = currentTurnInput(events);
  if (current?.inputMessageDigest === undefined) return {};
  return {
    inputMessageDigest: current.inputMessageDigest,
    eligible: current.eligible,
    ...(hasAmbiguousDuplicate(events, current.index, current.inputMessageDigest) ? { ambiguousDuplicate: true } : {}),
  };
}

export async function appendWaitSettled(runName: string, input: WaitSettledInput): Promise<WaitSettledEvent> {
  const event: WaitSettledEvent = {
    type: "wait-settled",
    run: runName,
    outcome: input.outcome,
    ...(input.completedVia !== undefined ? { completedVia: input.completedVia } : {}),
    at: input.at ?? new Date().toISOString(),
    sinceInputAt: input.sinceInputAt,
  };
  await appendEvent(runName, event);
  return event;
}

// Read the latest `wait-settled` record for the CURRENT turn. Returns undefined
// when no settle was ever recorded, or when the latest one is stale — superseded
// by a `send`/`interrupt` newer than the turn it resolved (`sinceInputAt`). This
// is the discipline that keeps `result` honest: a settled outcome from a prior
// turn never leaks onto a fresh, still-running turn.
export async function readWaitSettled(runName: string): Promise<WaitSettledEvent | undefined> {
  const events = await readEvents(runName);
  let lastTurnInputAt: string | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isTurnInputEvent(event)) continue;
    lastTurnInputAt = typeof event.at === "string" ? event.at : null;
    break;
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isWaitSettledEvent(event)) continue;
    if (waitSettledIsCurrent(event, lastTurnInputAt)) return event;
    return undefined;
  }
  return undefined;
}

async function readBackendSignalState(runName: string): Promise<BackendSignalEvent | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(runDir(runName), "state.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      (parsed.lastSignal === "turn-complete" || parsed.lastSignal === "awaiting-approval") &&
      typeof parsed.at === "string"
    ) {
      return {
        type: "backend-signal",
        run: runName,
        signal: parsed.lastSignal,
        at: parsed.at,
        ...(typeof parsed.turnId === "string" ? { turnId: parsed.turnId } : {}),
        ...(typeof parsed.inputMessageDigest === "string" ? { inputMessageDigest: parsed.inputMessageDigest } : {}),
        ...(parsed.explicit === true ? { explicit: true } : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isBackendSignalEvent(event: RunEvent): event is BackendSignalEvent {
  return (
    event.type === "backend-signal" &&
    (event.signal === "turn-complete" || event.signal === "awaiting-approval") &&
    typeof event.at === "string"
  );
}

interface CurrentTurnState {
  index: number;
  at: string | null;
  inputMessageDigest?: string;
  eligible: boolean;
}

// The event log is the authority for Codex delivery eligibility. A started
// record is deliberately not enough: a payload can arrive while delivery is in
// flight, but it becomes completion evidence only once its matching result says
// `submitted`. Failed, uncertain, and unresolved attempts remain a barrier so
// they cannot revive an earlier completed turn.
function currentTurnInput(events: RunEvent[]): CurrentTurnState | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "interrupt") {
      return { index, at: typeof event.at === "string" ? event.at : null, eligible: true };
    }
    if (event.type !== "send" || event.phase === "result") continue;
    if (event.phase !== "started") {
      return {
        index,
        at: typeof event.at === "string" ? event.at : null,
        ...(typeof event.inputMessageDigest === "string" ? { inputMessageDigest: event.inputMessageDigest } : {}),
        eligible: true,
      };
    }
    const result = resultForStarted(events, index);
    return {
      index,
      at: typeof event.at === "string" ? event.at : null,
      ...(typeof event.inputMessageDigest === "string" ? { inputMessageDigest: event.inputMessageDigest } : {}),
      eligible: result?.submission === "submitted",
    };
  }
  return undefined;
}

function resultForStarted(events: RunEvent[], startedIndex: number): RunEvent | undefined {
  const started = events[startedIndex];
  const sendId = typeof started.sendId === "string" ? started.sendId : undefined;
  const digest = typeof started.inputMessageDigest === "string" ? started.inputMessageDigest : undefined;
  for (let index = startedIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "send") continue;
    if (event.phase === "started" && sendId === undefined) return undefined;
    if (event.phase !== "result") continue;
    if (sendId !== undefined ? event.sendId === sendId : digest !== undefined && event.inputMessageDigest === digest) return event;
  }
  return undefined;
}

function hasAmbiguousDuplicate(events: RunEvent[], currentIndex: number, digest: string): boolean {
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isBackendSignalEvent(event) && (event.explicit === true || event.inputMessageDigest === digest)) return false;
    if (
      event.type === "send" &&
      event.phase !== "result" &&
      event.inputMessageDigest === digest &&
      (event.phase !== "started" || resultForStarted(events, index)?.submission === "submitted")
    ) {
      return true;
    }
  }
  return false;
}

function isTurnInputEvent(event: RunEvent): boolean {
  return event.type === "interrupt" || (event.type === "send" && event.phase !== "result");
}

function signalIsAfterLastTurnInput(signal: BackendSignalEvent, lastTurnInputAt: string | null): boolean {
  if (lastTurnInputAt === null) return true;
  const signalAt = Date.parse(signal.at);
  const inputAt = Date.parse(lastTurnInputAt);
  if (!Number.isFinite(signalAt) || !Number.isFinite(inputAt)) return false;
  return signalAt > inputAt;
}

function isWaitSettledEvent(event: RunEvent): event is WaitSettledEvent {
  return (
    event.type === "wait-settled" &&
    (event.outcome === "done" || event.outcome === "timeout" || event.outcome === "blocked") &&
    typeof event.at === "string"
  );
}

// A settle is current when nothing has been sent since the turn it resolved.
// It resolved against `sinceInputAt`; the run's current turn is keyed by
// `lastTurnInputAt`. If those match (including both null — a never-sent run), the
// settle still describes the live turn. If a newer `send`/`interrupt` advanced
// `lastTurnInputAt` past `sinceInputAt`, the settle belongs to a prior turn and
// is stale. Unparseable timestamps are treated as stale (fail closed, never
// fabricate).
function waitSettledIsCurrent(event: WaitSettledEvent, lastTurnInputAt: string | null): boolean {
  if (lastTurnInputAt === event.sinceInputAt) return true;
  if (lastTurnInputAt === null || event.sinceInputAt === null) return false;
  const currentAt = Date.parse(lastTurnInputAt);
  const settledAgainst = Date.parse(event.sinceInputAt);
  if (!Number.isFinite(currentAt) || !Number.isFinite(settledAgainst)) return false;
  // A newer turn input makes the settle stale; an equal/older one keeps it current.
  return currentAt <= settledAgainst;
}

// Derive concurrency visibility from the latest mutation event: `lastInputAt` from
// its `at`, `lastInputBy` from its `by` (null for legacy events written before the
// `by` field existed). Frozen §3.
export async function lastInput(runName: string): Promise<LastInput> {
  const events = await readEvents(runName);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!MUTATION_TYPES.has(event.type)) continue;
    return {
      lastInputAt: typeof event.at === "string" ? event.at : null,
      lastInputBy: typeof event.by === "string" ? event.by : null,
    };
  }
  return { lastInputAt: null, lastInputBy: null };
}
