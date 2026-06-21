import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { WuxError } from "../runtime/errors";
import type { RunMeta, RunStatus } from "../runtime/runs";
import { runsRoot } from "../runtime/state";
import { hasSession, tmuxSessionName } from "../runtime/tmux";

export interface PruneOptions {
  days?: number;
  // Age cutoff in milliseconds. A stopped run is a candidate when its retention
  // timestamp is strictly older than `now - olderThanMs`. `0` is the explicit
  // "select every stopped run regardless of age" path: it ignores the retention
  // timestamp entirely so a seconds-old (or even timestamp-less) stopped run is
  // selected. Takes precedence over `days`; the CLI rejects supplying both.
  olderThanMs?: number;
  dryRun: boolean;
  now?: Date;
}

export interface PruneEntry {
  name: string;
  action: "pruned" | "would-prune" | "skipped";
  reason?: string;
}

export interface PruneResult {
  entries: PruneEntry[];
  pruned: number;
  wouldPrune: number;
  skipped: number;
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
  const result = emptyResult();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const dir = join(root, name);
    const decision = await decideRun(name, dir, cutoffMs, selectAll);
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
  lines.push(`summary: pruned ${result.pruned}, would-prune ${result.wouldPrune}, skipped ${result.skipped}`);
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

async function decideRun(name: string, dir: string, cutoffMs: number, selectAll: boolean): Promise<PruneEntry> {
  const meta = await loadMeta(dir);
  if (!meta) return { name, action: "skipped", reason: "missing or invalid metadata" };

  if (await hasSession(meta.tmuxSession ?? tmuxSessionName(name))) {
    return { name, action: "skipped", reason: "live tmux session" };
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

function emptyResult(): PruneResult {
  return { entries: [], pruned: 0, wouldPrune: 0, skipped: 0 };
}
