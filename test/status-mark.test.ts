import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { markCommand } from "../src/commands/mark";
import { formatStatusRows, statusJsonCommand, statusRows } from "../src/commands/status";
import { runCommand } from "../src/commands/run";
import { loadRun } from "../src/runtime/runs";
import { hasTmux, killTmux, tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("status and mark", () => {
  test("lists live runs and persists mark events", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("status-live");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;

      const runningRows = await statusRows();
      const running = runningRows.find((row) => row.name === name);
      expect(running).toEqual({
        name,
        backend: "shell",
        status: "running",
        owner: expect.any(String),
        cwd: temp.root,
        lastInputBy: null,
        lastInputAt: null,
      });
      expect(formatStatusRows(runningRows)).toContain("NAME");
      expect(formatStatusRows(runningRows)).toContain(name);

      await markCommand(name, "blocked");
      expect((await loadRun(name)).status).toBe("blocked");
      expect((await statusRows()).find((row) => row.name === name)?.status).toBe("blocked");

      await expect(markCommand(name, "stopped")).rejects.toThrow("tmux session is still running");

      const events = await readFile(join(temp.stateHome, "wux", "runs", name, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"mark"');
      expect(events).toContain('"status":"blocked"');
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("reports absent sessions as unknown and permits stopped marks", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("status-dead");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      await killTmux(name);
      created = false;

      expect((await statusRows()).find((row) => row.name === name)?.status).toBe("unknown");
      await expect(markCommand(name, "waiting")).rejects.toThrow("tmux session is not running");

      await markCommand(name, "stopped");
      expect((await loadRun(name)).status).toBe("stopped");
      expect((await statusRows()).find((row) => row.name === name)?.status).toBe("stopped");
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("rejects invalid mark statuses before loading state", async () => {
    await expect(markCommand("any-run", "paused" as never)).rejects.toThrow("invalid status");
  });

  test("status json preserves legacy command while absent liveness has derivedStatus unknown", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("status-legacy");

    try {
      const dir = join(temp.stateHome, "wux", "runs", name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "meta.json"),
        `${JSON.stringify(
          {
            name,
            backend: "shell",
            tmuxSession: `wux_${name}`,
            cwd: temp.root,
            owner: "legacy@host",
            createdAt: "2026-06-08T00:00:00.000Z",
            status: "running",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = await statusJsonCommand({ probe: async () => ({ state: "absent", detail: "can't find session" }) });
      const row = result.runs.find((run) => run.name === name);
      expect(row).toBeDefined();
      expect(Object.hasOwn(row as object, "command")).toBe(true);
      expect(row?.command).toEqual([]);
      expect(row).toMatchObject({ status: "running", liveness: "absent", derivedStatus: "unknown" });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("unreachable stored socket has unavailable liveness and unknown derived status", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("status-unavailable");

    try {
      const dir = join(temp.stateHome, "wux", "runs", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "meta.json"), `${JSON.stringify({
        name,
        backend: "shell",
        tmuxSession: `wux_${name}`,
        tmuxSocketPath: join(temp.root, "missing.sock"),
        cwd: temp.root,
        owner: "test@host",
        createdAt: "2026-06-08T00:00:00.000Z",
        status: "running",
      })}\n`, "utf8");

      expect((await statusJsonCommand({ probe: async () => ({ state: "unavailable", detail: "permission denied" }) })).runs.find((run) => run.name === name)).toMatchObject({
        status: "running",
        liveness: "unavailable",
        derivedStatus: "unknown",
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("invalid tmuxSocketPath is unavailable and status json command succeeds", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("status-invalid-socket");

    try {
      const dir = join(temp.stateHome, "wux", "runs", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "meta.json"), `${JSON.stringify({
        name,
        backend: "shell",
        tmuxSession: `wux_${name}`,
        tmuxSocketPath: "not-an-absolute-path",
        cwd: temp.root,
        owner: "test@host",
        createdAt: "2026-06-08T00:00:00.000Z",
        status: "running",
      })}\n`, "utf8");

      await expect(statusJsonCommand()).resolves.toMatchObject({
        runs: [expect.objectContaining({ name, liveness: "unavailable", derivedStatus: "unknown" })],
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("status json skips structurally malformed metadata objects", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("status-malformed");
    try {
      const dir = join(temp.stateHome, "wux", "runs", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "meta.json"), `${JSON.stringify({ name, status: "running" })}\n`, "utf8");
      await expect(statusJsonCommand()).resolves.toEqual({ runs: [] });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});
