import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBackendSignalObservation } from "../runtime/events";
import { WuxError } from "../runtime/errors";
import { loadRun as loadRunMeta } from "../runtime/runs";
import { runDir } from "../runtime/state";
import { type CompletedVia, resolveSignalSnapshot, type WaitOutcome, type WaitResult } from "./wait";

// Backend-agnostic result envelope composed read-only from existing run state.
// It answers "what did this run produce?" by surfacing the worker's last turn
// signal (already recorded on the `backend-signal` event) plus pointers an
// operator follows for out-of-band ground truth. wux owns the schema, never the
// content: there are no git/gh/test/PR connectors here — `runDir`, `paneLogPath`,
// `eventsPath`, and `sentinelPath` are pointers the caller resolves itself.
export interface ResultEnvelope {
  name: string;
  outcome: WaitOutcome;
  completedVia?: CompletedVia;
  turnId?: string;
  lastAssistantMessage?: string;
  signalAt?: string;
  runDir: string;
  paneLogPath: string;
  eventsPath: string;
  sentinelPath?: string;
}

interface ResultRunMeta {
  name: string;
  backend: string;
}

export interface ResultOptions {
  name: string;
  loadRun?: (name: string) => Promise<ResultRunMeta>;
}

export async function resultCommand(options: ResultOptions): Promise<ResultEnvelope> {
  if (!options.name) throw new WuxError("result requires <run-name>");
  const loadRun = options.loadRun ?? loadRunMeta;
  const meta = await loadRun(options.name);

  // Snapshot resolution reuses wait's `hook > sentinel` probes at one point in
  // time (no polling loop — result is a snapshot, wait is the blocker).
  const snapshot = await resolveSignalSnapshot({ name: meta.name, backend: meta.backend });
  return buildResultEnvelope(meta.name, snapshot.outcome, snapshot.completedVia, snapshot.observation.signal);
}

// Compose the pointer + signal half of the envelope from existing run state,
// stamping an authoritative outcome/completedVia. `result` derives these from a
// snapshot; `wait --result` reuses this with its own blocking resolution so the
// inlined envelope matches what `wait` actually observed. Shared so both paths
// produce byte-identical pointer/signal fields with no reconstruction drift.
export function buildResultEnvelope(
  name: string,
  outcome: WaitOutcome,
  completedVia: CompletedVia | undefined,
  signal: { turnId?: string; lastAssistantMessage?: string; at?: string } | undefined,
): ResultEnvelope {
  const dir = runDir(name);
  const sentinelPath = join(dir, "turn-complete");
  return {
    name,
    outcome,
    ...(completedVia !== undefined ? { completedVia } : {}),
    // Shell runs legitimately have no turnId/lastAssistantMessage — omit, never
    // fabricate. claude/codex turns carry them on the latest backend-signal.
    ...(signal?.turnId !== undefined ? { turnId: signal.turnId } : {}),
    ...(signal?.lastAssistantMessage !== undefined ? { lastAssistantMessage: signal.lastAssistantMessage } : {}),
    ...(signal?.at !== undefined ? { signalAt: signal.at } : {}),
    runDir: dir,
    paneLogPath: join(dir, "pane.log"),
    eventsPath: join(dir, "events.jsonl"),
    ...(existsSync(sentinelPath) ? { sentinelPath } : {}),
  };
}

// Exit code mirrors the outcome, consistent with `waitExitCode`: done is 0,
// everything else (blocked/timeout/unknown) is nonzero so a loop can branch.
export function resultExitCode(envelope: ResultEnvelope): number {
  return envelope.outcome === "done" ? 0 : 1;
}

// Human-readable rendering for the non-`--json` path. The envelope is designed
// for machines; the text form is a terse one-liner plus the pointers an operator
// follows by hand.
export function formatResultEnvelope(envelope: ResultEnvelope): string {
  const via = envelope.completedVia ? ` (${envelope.completedVia})` : "";
  const lines = [`result ${envelope.name}: ${envelope.outcome}${via}`];
  if (envelope.lastAssistantMessage !== undefined) {
    lines.push(`  lastAssistantMessage: ${envelope.lastAssistantMessage}`);
  }
  if (envelope.turnId !== undefined) lines.push(`  turnId: ${envelope.turnId}`);
  lines.push(`  runDir: ${envelope.runDir}`);
  lines.push(`  paneLogPath: ${envelope.paneLogPath}`);
  lines.push(`  eventsPath: ${envelope.eventsPath}`);
  if (envelope.sentinelPath !== undefined) lines.push(`  sentinelPath: ${envelope.sentinelPath}`);
  return `${lines.join("\n")}\n`;
}

// `wux wait --json --result` convenience: inline the same envelope so an
// autonomous loop needs one call. The outcome/completedVia come from `wait`'s
// actual blocking resolution (authoritative, includes quiescence which a snapshot
// cannot see); the signal/pointer fields compose from existing run state. Shell
// runs carry no backend signal, so turnId/lastAssistantMessage are omitted.
//
// Signal freshness MUST match the standalone `result` path: read via
// `readBackendSignalObservation` (turn-scoped — honours `lastTurnInputAt`) so a
// turn-complete signal recorded before a newer `send`/`interrupt` is treated as
// stale and its turnId/lastAssistantMessage/signalAt are omitted. Using the
// unfiltered `readLatestBackendSignal` here would attach a previous turn's output
// to a fresh `done` envelope when `wait` resolves the current turn via
// quiescence/timeout — fabricating the current turn's result and diverging from
// what `wux result` reports.
export async function waitResultEnvelope(
  result: WaitResult,
  loadRun: (name: string) => Promise<ResultRunMeta> = loadRunMeta,
): Promise<ResultEnvelope> {
  const meta = await loadRun(result.name);
  const signal = meta.backend === "shell" ? undefined : (await readBackendSignalObservation(result.name)).signal;
  return buildResultEnvelope(result.name, result.outcome, result.completedVia, signal);
}
