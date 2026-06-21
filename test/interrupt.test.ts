import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { interruptCommand } from "../src/commands/interrupt";
import { runCommand } from "../src/commands/run";
import { sendCommand } from "../src/commands/send";
import type { ProcessResult } from "../src/runtime/process";
import { loadRun, saveRun } from "../src/runtime/runs";
import { interruptSession } from "../src/runtime/tmux";
import { hasTmux, killTmux, tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("interruptSession", () => {
  test("sends exactly one C-c as a key name (no -l)", async () => {
    const calls: string[][] = [];
    await interruptSession("wux_x", async (args): Promise<ProcessResult> => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(calls).toEqual([["tmux", "send-keys", "-t", "=wux_x:", "C-c"]]);
  });

  test("throws a WuxError when the tmux command fails", async () => {
    await expect(
      interruptSession("wux_x", async (): Promise<ProcessResult> => ({ code: 1, stdout: "", stderr: "boom" })),
    ).rejects.toThrow("interrupt");
  });
});

describe("interrupt", () => {
  test("interrupts a live run, appends an event, and returns control to the shell", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("interrupt-live");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      // Start a long-running foreground command, then interrupt it.
      await sendCommand({ name, text: "sleep 60", forceOwner: false });
      await wait(500);
      const result = await interruptCommand({ name, forceOwner: false });
      expect(result).toEqual({ name, interrupted: true });
      await wait(300);
      // If the C-c landed, the shell regained control and runs the next command.
      await sendCommand({ name, text: "echo back-after-interrupt", forceOwner: false });
      await wait(600);

      const dir = join(temp.stateHome, "wux", "runs", name);
      expect(await readFile(join(dir, "pane.log"), "utf8")).toContain("back-after-interrupt");
      expect(await readFile(join(dir, "events.jsonl"), "utf8")).toContain('"type":"interrupt"');
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("rejects missing, stopped, and cross-owner runs", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("interrupt-guard");
    let created = false;

    try {
      await expect(interruptCommand({ name: "missing-run", forceOwner: false })).rejects.toThrow("run not found");
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const meta = await loadRun(name);
      await saveRun({ ...meta, status: "stopped" });
      await expect(interruptCommand({ name, forceOwner: false })).rejects.toThrow("run is stopped");
      await saveRun({ ...meta, status: "running", owner: "other@owner" });
      await expect(interruptCommand({ name, forceOwner: false })).rejects.toThrow("--force-owner");
      const forced = await interruptCommand({ name, forceOwner: true });
      expect(forced).toEqual({ name, interrupted: true });
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("rejects a run whose tmux session is gone (active metadata, no session)", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("interrupt-dead");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      // Metadata still says running, but the tmux session is gone.
      await killTmux(name);
      created = false;
      await expect(interruptCommand({ name, forceOwner: false })).rejects.toThrow("tmux session is not running");
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});
