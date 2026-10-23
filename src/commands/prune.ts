import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { WuxError } from "../runtime/errors";
import { finalizeStopped, type RunMeta, type RunStatus } from "../runtime/runs";
import { runsRoot } from "../runtime/state";
import { connectionForMeta, isDefinitivelyAbsentTmuxDetail, probeSession, tmuxSessionName } from "../runtime/tmux";

export interface PruneOptions {
  days?: number;
  // Age cutoff in milliseconds. A stopped run is a candidate when its retention
  // timestamp is strictly older than `now - olderThanMs`. `0` is the explicit
  // "select every stopped run regardless of age" path: it ignores the retention
  // timestamp entirely so a seconds-old (or even timestamp-less) stopped run is
  // selected. Takes precedence over `days`; the CLI rejects supplying both.
  olderThanMs?: number;
  dryRun: boolean;
  reconcile?: boolean;
  prefix?: string;
  now?: Date;
}

export interface PruneEntry {
  name: string;
  action: "pruned" | "would-prune" | "reconciled" | "would-reconcile" | "skipped";
  reason?: string;
  reconciled?: boolean;
}

export interface PruneResult {
  entries: PruneEntry[];
  pruned: number;
  wouldPrune: number;
  skipped: number;
  reconciled?: number;
}

const DEFAULT_PRUNE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set<RunStatus>(["running", "waiting", "blocked"]);

export async function pruneRuns(options: PruneOptions): Promise<PruneResult> {
  const ageMs = resolveAgeMs(options);

  const root = runsRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyResult();
    throw error;
  }

  // `selectAll` (age 0) ignores the retention timestamp; otherwise a stopped run
  // is a candidate only when its latest retention timestamp is strictly older
  // than this cutoff ("stopped more than <age> ago").
  const selectAll = ageMs === 0;
  const cutoffMs = (options.now ?? new Date()).getTime() - ageMs;
  const result = emptyResult(options.reconcile === true);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (options.prefix !== undefined && !name.startsWith(options.prefix)) continue;
    const dir = join(root, name);
    const decision = await decideRun(name, dir, cutoffMs, selectAll, options.reconcile === true, options.dryRun);
    if (decision.reconciled) result.reconciled = (result.reconciled ?? 0) + 1;
    if (decision.action === "would-reconcile" || decision.action === "reconciled") {
      result.entries.push(decision);
      continue;
    }
    if (decision.action === "skipped") {
      result.entries.push(decision);
      result.skipped += 1;
      continue;
    }

    if (options.dryRun) {
      result.entries.push({ name, action: "would-prune" });
      result.wouldPrune += 1;
      continue;
    }

    await rm(dir, { recursive: true, force: true });
    result.entries.push({ name, action: "pruned" });
    result.pruned += 1;
  }

  return result;
}

export async function pruneCommand(options: PruneOptions): Promise<void> {
  process.stdout.write(formatPruneResult(await pruneRuns(options)));
}

export function formatPruneResult(result: PruneResult): string {
  const lines = result.entries.map((entry) => {
    if (entry.action === "skipped") return `skip ${entry.name}: ${entry.reason}`;
    if (entry.action === "would-prune") return `would prune ${entry.name}`;
    return `pruned ${entry.name}`;
  });
  lines.push(`summary: pruned ${result.pruned}, would-prune ${result.wouldPrune}${result.reconciled === undefined ? "" : `, reconciled ${result.reconciled}`}, skipped ${result.skipped}`);
  return `${lines.join("\n")}\n`;
}

// Resolves the age cutoff (in ms) from options. `olderThanMs` wins over `days`;
// supplying both is rejected at the CLI boundary, so this only guards the API.
// `olderThanMs: 0` is the explicit "select all stopped runs" path. `days` keeps
// its long-standing positive-integer contract.
function resolveAgeMs(options: PruneOptions): number {
  if (options.olderThanMs !== undefined) {
    if (options.days !== undefined) {
      throw new WuxError("pass either --older-than or --days, not both");
    }
    if (!Number.isSafeInteger(options.olderThanMs) || options.olderThanMs < 0) {
      throw new WuxError("--older-than must be a non-negative duration");
    }
    return options.olderThanMs;
  }

  const days = options.days ?? DEFAULT_PRUNE_DAYS;
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new WuxError("--days must be a positive integer");
  }
  return days * MS_PER_DAY;
}

async function decideRun(name: string, dir: string, cutoffMs: number, selectAll: boolean, reconcile: boolean, dryRun: boolean): Promise<PruneEntry> {
  const meta = await loadMeta(dir);
  if (!meta) return { name, action: "skipped", reason: "missing or invalid metadata" };

  let connection;
  try {
    connection = connectionForMeta(meta);
  } catch (error) {
    if (error instanceof WuxError) return { name, action: "skipped", reason: "tmux server unavailable" };
    throw error;
  }
  const probe = await probeSession(meta.tmuxSession ?? tmuxSessionName(name), connection);
  if (probe.state === "live") {
    return { name, action: "skipped", reason: "live tmux session" };
  }
  if (probe.state === "unavailable") {
    return { name, action: "skipped", reason: "tmux server unavailable" };
  }

  if ((!meta.status || ACTIVE_STATUSES.has(meta.status)) && reconcile) {
    if (!Object.hasOwn(meta, "tmuxSocketPath") && !isDefinitivelyAbsentTmuxDetail(probe.detail ?? "")) {
      return { name, action: "skipped", reason: "indeterminate tmux state" };
    }
    if (dryRun) return { name, action: "would-reconcile" };
    const timestampMs = await latestTimestampMs(dir, meta);
    const stopped = await finalizeStopped(meta, "prune --reconcile");
    return await pruneReconciled(name, dir, stopped, timestampMs, cutoffMs, selectAll);
  }
  if (!meta.status || ACTIVE_STATUSES.has(meta.status)) {
    return { name, action: "skipped", reason: `active status ${meta.status ?? "unknown"}` };
  }

  if (meta.status !== "stopped") {
    return { name, action: "skipped", reason: `unsupported status ${meta.status}` };
  }

  // Age 0 selects every stopped run regardless of (or even absent) a timestamp.
  if (selectAll) return { name, action: "pruned" };

  const timestampMs = await latestTimestampMs(dir, meta);
  if (timestampMs === undefined) return { name, action: "skipped", reason: "no retention timestamp" };
  if (timestampMs >= cutoffMs) return { name, action: "skipped", reason: "newer than cutoff" };
  return { name, action: "pruned" };
}

async function pruneReconciled(name: string, dir: string, meta: RunMeta, timestampMs: number | undefined, cutoffMs: number, selectAll: boolean): Promise<PruneEntry> {
  if (!selectAll && (timestampMs === undefined || timestampMs >= cutoffMs)) return { name, action: "reconciled", reconciled: true };
  await rm(dir, { recursive: true, force: true });
  return { name, action: "pruned", reconciled: true };
}

async function loadMeta(dir: string): Promise<RunMeta | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as RunMeta;
  } catch {
    return undefined;
  }
}

async function latestTimestampMs(dir: string, meta: RunMeta): Promise<number | undefined> {
  const timestamps: number[] = [];
  const stoppedAt = meta.stoppedAt ? Date.parse(meta.stoppedAt) : Number.NaN;
  if (Number.isFinite(stoppedAt)) timestamps.push(stoppedAt);

  for (const file of ["meta.json", "pane.log", "events.jsonl"]) {
    try {
      timestamps.push((await stat(join(dir, file))).mtimeMs);
    } catch {
      // Optional retention inputs.
    }
  }

  if (timestamps.length === 0) return undefined;
  return Math.max(...timestamps);
}

function emptyResult(withReconciled = false): PruneResult {
  return { entries: [], pruned: 0, wouldPrune: 0, skipped: 0, ...(withReconciled ? { reconciled: 0 } : {}) };
}
