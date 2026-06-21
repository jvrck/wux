import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  appendWaitSettled,
  type BackendSignalObservation,
  readBackendSignalObservation,
  readWaitSettled,
  type WaitSettledInput,
} from "../runtime/events";
import { WuxError } from "../runtime/errors";
import { loadRun as loadRunMeta } from "../runtime/runs";
import { runDir } from "../runtime/state";
import {
  capturePane as captureTmuxPane,
  hasSession as hasTmuxSession,
  type PaneActivity,
  paneForegroundActivity as probePaneActivity,
} from "../runtime/tmux";

export type CompletedVia = "hook" | "sentinel" | "quiescence";
export type WaitOutcome = "done" | "timeout" | "blocked" | "unknown";

export interface WaitResult {
  name: string;
  outcome: WaitOutcome;
  completedVia?: CompletedVia;
  idleMs: number;
  timeoutMs: number;
  waitedMs: number;
  pollIntervalMs: number;
}

// Single-point-in-time resolution shared with `result`. Unlike `wait`, this never
// polls and never measures quiescence (which requires an idle window), so a live
// session with no hook/sentinel signal stays `unknown` rather than fabricating a
// completion. Mirrors `wait`'s `hook > sentinel > liveness` ladder for one sample.
export interface SignalSnapshot {
  outcome: WaitOutcome;
  completedVia?: CompletedVia;
  observation: BackendSignalObservation;
}

interface SnapshotMeta {
  name: string;
  backend: string;
}

interface SnapshotProbes {
  readObservation?: (name: string) => Promise<BackendSignalObservation>;
  probeSentinel?: (name: string, lastTurnInputAt: string | null) => Promise<CompletedVia | undefined>;
  readSettled?: (name: string) => Promise<WaitSettledRecord | undefined>;
}

interface WaitSettledRecord {
  outcome: WaitOutcome;
  completedVia?: CompletedVia;
}

export async function resolveSignalSnapshot(meta: SnapshotMeta, probes: SnapshotProbes = {}): Promise<SignalSnapshot> {
  const readObservation = probes.readObservation ?? readBackendSignalObservation;
  const probeSentinel = probes.probeSentinel ?? probeSentinelSignal;
  const readSettled = probes.readSettled ?? readWaitSettled;
  const isShell = meta.backend === "shell";

  const observation = isShell ? { signal: undefined, lastTurnInputAt: null } : await readObservation(meta.name);
  const hook = observation.signal;
  if (!isShell && hook?.signal === "turn-complete") {
    return { outcome: "done", completedVia: "hook", observation };
  }
  if (!isShell && hook?.signal === "awaiting-approval") {
    return { outcome: "blocked", completedVia: "hook", observation };
  }

  const sentinel = isShell ? undefined : await probeSentinel(meta.name, observation.lastTurnInputAt);
  if (sentinel) {
    return { outcome: "done", completedVia: sentinel, observation };
  }

  // No live hook/sentinel completion. Before falling through to `unknown`, surface
  // the outcome `wait` already settled for the CURRENT turn (if any): this is the
  // only way a snapshot can report `done`/`quiescence` for a shell run, or a
  // `timeout`/`blocked` that `wait` resolved. `readWaitSettled` is turn-scoped — a
  // record superseded by a newer `send`/`interrupt` is treated as stale and
  // ignored, so a fresh turn never inherits a prior turn's outcome (no fabrication).
  const settled = await readSettled(meta.name);
  if (settled) {
    return { outcome: settled.outcome, ...(settled.completedVia !== undefined ? { completedVia: settled.completedVia } : {}), observation };
  }

  // No hook/sentinel completion and no current-turn settle: a snapshot cannot
  // measure quiescence (that needs an idle window only `wait` polls), so the
  // outcome stays unknown rather than fabricating a completion — true for a
  // never-`wait`ed shell run and idle claude/codex runs alike.
  return { outcome: "unknown", observation };
}

interface WaitRunMeta {
  name: string;
  tmuxSession: string;
  backend: string;
}

export interface WaitOptions {
  name: string;
  idleMs?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  loadRun?: (name: string) => Promise<WaitRunMeta>;
  hasSession?: (session: string) => Promise<boolean>;
  capturePane?: (session: string, tail: number) => Promise<string>;
  // Foreground-process activity probe for shell runs. Lets `wait` distinguish a
  // pane that is genuinely idle (prompt returned) from one that is byte-static
  // only because a silent-but-busy child is running. Injectable for tests.
  paneActivity?: (session: string) => Promise<PaneActivity>;
  // Persist a terminal settle so `result` can replay it; default writes a
  // `wait-settled` event. Injectable so pure clock-driven tests can assert what
  // `wait` persisted without touching real state. `sinceInputAt` defaults to the
  // current `lastTurnInputAt` (re-read at settle to capture a mid-wait `send`).
  appendSettled?: (name: string, input: WaitSettledInput) => Promise<unknown>;
  readTurnInputAt?: (name: string) => Promise<string | null>;
}

export const DEFAULT_WAIT_IDLE_MS = 1_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 250;

const WAIT_CAPTURE_TAIL = 200;

export async function waitCommand(options: WaitOptions): Promise<WaitResult> {
  if (!options.name) throw new WuxError("wait requires <run-name>");
  const idleMs = options.idleMs ?? DEFAULT_WAIT_IDLE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  validateWaitTiming(idleMs, timeoutMs, pollIntervalMs);

  const loadRun = options.loadRun ?? loadRunMeta;
  const hasSession = options.hasSession ?? hasTmuxSession;
  const capturePane = options.capturePane ?? captureTmuxPane;
  const paneActivity = options.paneActivity ?? ((session: string) => probePaneActivity(session));
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const appendSettled = options.appendSettled ?? appendWaitSettled;
  const readTurnInputAt =
    options.readTurnInputAt ?? (async (name: string) => (await readBackendSignalObservation(name)).lastTurnInputAt);
  const startedAt = now();
  const meta = await loadRun(options.name);
  let previousHash: string | undefined;
  let idleAccumulatedMs = 0;
  let lastSampleAt = startedAt;

  // Persist every terminal settle (done/timeout/blocked) so the read-only
  // `result` snapshot can report the same outcome — including `quiescence`, which
  // a snapshot can never observe. Stamped with the turn it resolved against
  // (`lastTurnInputAt`, re-read at settle so a `send` that landed mid-wait is
  // captured) for staleness. `unknown` is never persisted: a session-gone /
  // no-signal result must not pin a run to `unknown`, and a never-`wait`ed run
  // must keep reporting `unknown` from the snapshot path (no fabrication).
  const settle = async (result: WaitResult): Promise<WaitResult> => {
    if (result.outcome !== "unknown") {
      const sinceInputAt = await readTurnInputAt(meta.name);
      await appendSettled(meta.name, {
        outcome: result.outcome,
        ...(result.completedVia !== undefined ? { completedVia: result.completedVia } : {}),
        sinceInputAt,
      });
    }
    return result;
  };

  while (true) {
    const observedAt = now();
    const signalObservation = meta.backend === "shell" ? undefined : await readBackendSignalObservation(meta.name);
    const hook = signalObservation?.signal;
    if (hook?.signal === "turn-complete") {
      return settle({ ...baseResult(meta.name, "done", idleMs, timeoutMs, elapsed(startedAt, observedAt), pollIntervalMs), completedVia: "hook" });
    }
    if (hook?.signal === "awaiting-approval") {
      return settle({ ...baseResult(meta.name, "blocked", idleMs, timeoutMs, elapsed(startedAt, observedAt), pollIntervalMs), completedVia: "hook" });
    }

    const sentinel = meta.backend === "shell" ? undefined : await probeSentinelSignal(meta.name, signalObservation?.lastTurnInputAt ?? null);
    if (sentinel) {
      return settle({ ...baseResult(meta.name, "done", idleMs, timeoutMs, elapsed(startedAt, observedAt), pollIntervalMs), completedVia: sentinel });
    }

    if (!(await hasSession(meta.tmuxSession))) {
      return settle(baseResult(meta.name, "unknown", idleMs, timeoutMs, elapsed(startedAt, observedAt), pollIntervalMs));
    }

    const frameHash = hashFrame(await capturePane(meta.tmuxSession, WAIT_CAPTURE_TAIL));
    if (frameHash === previousHash) {
      idleAccumulatedMs += Math.max(0, observedAt - lastSampleAt);
    } else {
      previousHash = frameHash;
      idleAccumulatedMs = 0;
    }
    lastSampleAt = observedAt;

    if (idleAccumulatedMs >= idleMs) {
      // Pane silence != process idle. A silent-but-busy shell run (e.g.
      // `yes > /dev/null`, a compute writing only to a file) leaves the pane
      // byte-static, so frame-hash quiescence alone would falsely report `done`.
      // Before declaring quiescence for a shell run, confirm the pane's
      // foreground process is the shell itself (prompt returned). If a foreground
      // child is still running, reset the idle accumulator and keep waiting; the
      // run then resolves `timeout` rather than a false `done`. claude/codex
      // ladder behavior is unchanged — they never reach this rung silently busy
      // because their hook/sentinel rungs run first.
      if (meta.backend === "shell" && (await paneActivity(meta.tmuxSession)) === "foreground-busy") {
        idleAccumulatedMs = 0;
      } else {
        return settle({
          ...baseResult(meta.name, "done", idleMs, timeoutMs, elapsed(startedAt, observedAt), pollIntervalMs),
          completedVia: "quiescence",
        });
      }
    }

    if (elapsed(startedAt, observedAt) >= timeoutMs) {
      return settle(baseResult(meta.name, "timeout", idleMs, timeoutMs, elapsed(startedAt, observedAt), pollIntervalMs));
    }

    await sleep(pollIntervalMs);
  }
}

export async function probeHookSignal(_name: string): Promise<CompletedVia | undefined> {
  const { signal } = await readBackendSignalObservation(_name);
  return signal?.signal === "turn-complete" ? "hook" : undefined;
}

export async function probeSentinelSignal(name: string, lastTurnInputAt: string | null = null): Promise<CompletedVia | undefined> {
  try {
    const sentinel = await stat(join(runDir(name), "turn-complete"));
    if (lastTurnInputAt !== null) {
      const inputAt = Date.parse(lastTurnInputAt);
      if (Number.isFinite(inputAt) && sentinel.mtimeMs <= inputAt) return undefined;
    }
    return "sentinel";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function waitExitCode(result: WaitResult): number {
  return result.outcome === "done" ? 0 : 1;
}

export function formatWaitResult(result: WaitResult): string {
  if (result.outcome === "done") {
    const via = result.completedVia === "quiescence" ? "quiescence heuristic" : `${result.completedVia} signal`;
    return `wait ${result.name}: settled (${via}) after ${result.waitedMs}ms\n`;
  }
  if (result.outcome === "blocked") {
    return `wait ${result.name}: awaiting approval (${result.completedVia} signal) after ${result.waitedMs}ms\n`;
  }
  if (result.outcome === "unknown") {
    return `wait ${result.name}: tmux session is gone with no completion signal after ${result.waitedMs}ms\n`;
  }
  return `wait ${result.name}: timed out after ${result.waitedMs}ms\n`;
}

function validateWaitTiming(idleMs: number, timeoutMs: number, pollIntervalMs: number): void {
  if (!Number.isSafeInteger(idleMs) || idleMs <= 0) {
    throw new WuxError("--idle must be a positive duration");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new WuxError("--timeout must be a positive duration");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new WuxError("--poll-interval-ms must be a positive integer");
  }
}

function baseResult(
  name: string,
  outcome: WaitResult["outcome"],
  idleMs: number,
  timeoutMs: number,
  waitedMs: number,
  pollIntervalMs: number,
): WaitResult {
  return { name, outcome, idleMs, timeoutMs, waitedMs, pollIntervalMs };
}

function elapsed(startedAt: number, observedAt: number): number {
  return Math.max(0, observedAt - startedAt);
}

function hashFrame(frame: string): string {
  return createHash("sha256").update(frame).digest("hex");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
