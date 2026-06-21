import { describe, expect, test } from "bun:test";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pruneRuns, formatPruneResult } from "../src/commands/prune";
import { runCommand } from "../src/commands/run";
import { __test } from "../src/cli";
import { hasTmux, killTmux, tempState } from "./helpers";

const { parseAgeOption } = __test;

const NOW = new Date("2026-06-05T00:00:00.000Z");
const OLD = new Date("2000-01-01T00:00:00.000Z");

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("prune", () => {
  test("returns an empty result when the runs root does not exist", async () => {
    const temp = await tempState();
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      await expect(pruneRuns({ dryRun: false, now: NOW })).resolves.toEqual({ entries: [], pruned: 0, wouldPrune: 0, skipped: 0 });
    } finally {
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("dry-run reports old inactive runs without deleting them", async () => {
    const temp = await tempState();
    const old = await writeStoppedRun(temp.stateHome, "old-run", OLD);
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      const result = await pruneRuns({ dryRun: true, now: NOW });
      expect(result).toMatchObject({ pruned: 0, wouldPrune: 1, skipped: 0 });
      expect(result.entries).toEqual([{ name: "old-run", action: "would-prune" }]);
      expect(formatPruneResult(result)).toContain("would prune old-run");
      await stat(old);
    } finally {
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("deletes only eligible inactive run directories inside the state root", async () => {
    const temp = await tempState();
    const old = await writeStoppedRun(temp.stateHome, "old-delete", OLD);
    const fresh = await writeStoppedRun(temp.stateHome, "fresh-keep", NOW);
    const outside = join(temp.root, "outside-run");
    await mkdir(outside);
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      const result = await pruneRuns({ days: 30, dryRun: false, now: NOW });
      expect(result.entries).toEqual([
        { name: "fresh-keep", action: "skipped", reason: "newer than cutoff" },
        { name: "old-delete", action: "pruned" },
      ]);
      await expect(stat(old)).rejects.toThrow();
      await stat(fresh);
      await stat(outside);
    } finally {
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("skips live tmux sessions even when their files are old", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("prune-active");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const dir = join(temp.stateHome, "wux", "runs", name);
      await oldFile(join(dir, "meta.json"));
      await oldFile(join(dir, "pane.log"));
      await oldFile(join(dir, "events.jsonl"));

      const result = await pruneRuns({ days: 30, dryRun: false, now: NOW });
      expect(result.entries.find((entry) => entry.name === name)).toEqual({ name, action: "skipped", reason: "live tmux session" });
      await stat(dir);
    } finally {
      if (created) await killTmux(name);
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("skips live tmux sessions when old metadata omits tmuxSession", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("prune-legacy-active");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const dir = join(temp.stateHome, "wux", "runs", name);
      await writeFile(join(dir, "meta.json"), `${JSON.stringify({ name, status: "stopped", stoppedAt: OLD.toISOString() })}\n`, "utf8");
      await oldFile(join(dir, "meta.json"));
      await oldFile(join(dir, "pane.log"));
      await oldFile(join(dir, "events.jsonl"));

      const result = await pruneRuns({ days: 30, dryRun: false, now: NOW });
      expect(result.entries.find((entry) => entry.name === name)).toEqual({ name, action: "skipped", reason: "live tmux session" });
      await stat(dir);
    } finally {
      if (created) await killTmux(name);
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("skips active metadata and invalid metadata conservatively", async () => {
    const temp = await tempState();
    const active = await writeRunMeta(temp.stateHome, "active-meta", { name: "active-meta", status: "running" }, OLD);
    const broken = join(temp.stateHome, "wux", "runs", "broken-meta");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "meta.json"), "not-json", "utf8");
    await oldFile(join(broken, "meta.json"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      const result = await pruneRuns({ days: 30, dryRun: false, now: NOW });
      expect(result.entries).toEqual([
        { name: "active-meta", action: "skipped", reason: "active status running" },
        { name: "broken-meta", action: "skipped", reason: "missing or invalid metadata" },
      ]);
      await stat(active);
      await stat(broken);
    } finally {
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("validates days as a positive integer", async () => {
    await expect(pruneRuns({ days: 0, dryRun: false, now: NOW })).rejects.toThrow("--days");
    await expect(pruneRuns({ days: -1, dryRun: false, now: NOW })).rejects.toThrow("--days");
  });

  test("--older-than 0 selects a seconds-old stopped run in dry-run without deleting it", async () => {
    const temp = await tempState();
    // A run stopped one second ago: far younger than any day-granularity cutoff,
    // so --days would never select it, but age 0 must.
    const now = new Date();
    const justStopped = new Date(now.getTime() - 1_000);
    const dir = await writeStoppedRun(temp.stateHome, "fresh-disposable", justStopped);
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      // --days 0 would never reach this run; with the default 30d it is far too new.
      const byDays = await pruneRuns({ days: 30, dryRun: true, now });
      expect(byDays.entries).toEqual([{ name: "fresh-disposable", action: "skipped", reason: "newer than cutoff" }]);

      // age 0 selects it; --dry-run names the candidate dir and deletes nothing.
      const byAge = await pruneRuns({ olderThanMs: 0, dryRun: true, now });
      expect(byAge).toMatchObject({ pruned: 0, wouldPrune: 1, skipped: 0 });
      expect(byAge.entries).toEqual([{ name: "fresh-disposable", action: "would-prune" }]);
      expect(formatPruneResult(byAge)).toContain("would prune fresh-disposable");
      await stat(dir);
    } finally {
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("--older-than 0 deletes a seconds-old stopped run when not a dry-run", async () => {
    const temp = await tempState();
    const now = new Date();
    const dir = await writeStoppedRun(temp.stateHome, "fresh-delete", new Date(now.getTime() - 1_000));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      const result = await pruneRuns({ olderThanMs: 0, dryRun: false, now });
      expect(result.entries).toEqual([{ name: "fresh-delete", action: "pruned" }]);
      await expect(stat(dir)).rejects.toThrow();
    } finally {
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("--older-than applies an exclusive cutoff at fine granularity", async () => {
    const temp = await tempState();
    const now = new Date();
    // Stopped exactly 10 minutes ago.
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    const dir = await writeStoppedRun(temp.stateHome, "ten-min", tenMinutesAgo);
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      // 5m ago < 10m old: candidate.
      const selected = await pruneRuns({ olderThanMs: 5 * 60 * 1000, dryRun: true, now });
      expect(selected.entries).toEqual([{ name: "ten-min", action: "would-prune" }]);

      // 30m cutoff: the run is only 10m old, so it is newer than the cutoff.
      const kept = await pruneRuns({ olderThanMs: 30 * 60 * 1000, dryRun: true, now });
      expect(kept.entries).toEqual([{ name: "ten-min", action: "skipped", reason: "newer than cutoff" }]);
      await stat(dir);
    } finally {
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("--older-than 0 never lists a running run", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("prune-age-live");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const dir = join(temp.stateHome, "wux", "runs", name);

      // Even with the most aggressive cutoff, a live session is never a candidate.
      const result = await pruneRuns({ olderThanMs: 0, dryRun: true, now: new Date() });
      expect(result.entries.find((entry) => entry.name === name)).toEqual({ name, action: "skipped", reason: "live tmux session" });
      expect(result.wouldPrune).toBe(0);
      await stat(dir);
    } finally {
      if (created) await killTmux(name);
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("--older-than takes precedence over --days and rejects supplying both", async () => {
    const temp = await tempState();
    const now = new Date();
    await writeStoppedRun(temp.stateHome, "precedence", new Date(now.getTime() - 1_000));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      // Supplying both at the API boundary is rejected.
      await expect(pruneRuns({ olderThanMs: 0, days: 30, dryRun: true, now })).rejects.toThrow("--older-than or --days");
    } finally {
      restoreXdgStateHome(previous);
      await temp.cleanup();
    }
  });

  test("validates olderThanMs as a non-negative integer", async () => {
    await expect(pruneRuns({ olderThanMs: -1, dryRun: false, now: NOW })).rejects.toThrow("--older-than");
    await expect(pruneRuns({ olderThanMs: 1.5, dryRun: false, now: NOW })).rejects.toThrow("--older-than");
  });

  test("parseAgeOption accepts duration suffixes and 0, and rejects junk", () => {
    expect(parseAgeOption(undefined, "--older-than")).toBeUndefined();
    expect(parseAgeOption("0", "--older-than")).toBe(0);
    expect(parseAgeOption("0s", "--older-than")).toBe(0);
    expect(parseAgeOption("500", "--older-than")).toBe(500); // bare = ms
    expect(parseAgeOption("250ms", "--older-than")).toBe(250);
    expect(parseAgeOption("30s", "--older-than")).toBe(30_000);
    expect(parseAgeOption("10m", "--older-than")).toBe(600_000);
    expect(parseAgeOption("2h", "--older-than")).toBe(7_200_000);
    expect(parseAgeOption("7d", "--older-than")).toBe(604_800_000);
    expect(() => parseAgeOption("-1", "--older-than")).toThrow("non-negative duration");
    expect(() => parseAgeOption("3w", "--older-than")).toThrow("non-negative duration");
    expect(() => parseAgeOption("abc", "--older-than")).toThrow("non-negative duration");
    expect(() => parseAgeOption("1.5h", "--older-than")).toThrow("non-negative duration");
  });
});

async function writeStoppedRun(stateHome: string, name: string, timestamp: Date): Promise<string> {
  return writeRunMeta(stateHome, name, { name, status: "stopped", stoppedAt: timestamp.toISOString() }, timestamp);
}

async function writeRunMeta(stateHome: string, name: string, meta: Record<string, unknown>, timestamp: Date): Promise<string> {
  const dir = join(stateHome, "wux", "runs", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta)}\n`, "utf8");
  await writeFile(join(dir, "pane.log"), "old log\n", "utf8");
  await oldFile(join(dir, "meta.json"), timestamp);
  await oldFile(join(dir, "pane.log"), timestamp);
  return dir;
}

async function oldFile(path: string, timestamp = OLD): Promise<void> {
  await utimes(path, timestamp, timestamp);
}

function restoreXdgStateHome(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.XDG_STATE_HOME;
    return;
  }
  process.env.XDG_STATE_HOME = previous;
}
