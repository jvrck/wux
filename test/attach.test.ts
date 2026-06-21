import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { attachRun } from "../src/commands/attach";
import { runCommand } from "../src/commands/run";
import { runProcess, type ProcessResult } from "../src/runtime/process";
import { loadRun, saveRun } from "../src/runtime/runs";
import { attachArgs } from "../src/runtime/tmux";
import { hasTmux, killTmux, tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("attach", () => {
  test("builds attach and switch-client commands with exact tmux targets", () => {
    expect(attachArgs("wux_attach", {} as NodeJS.ProcessEnv)).toEqual(["tmux", "attach-session", "-t", "=wux_attach"]);
    expect(attachArgs("wux_attach", { TMUX: "/tmp/tmux-client" } as NodeJS.ProcessEnv)).toEqual([
      "tmux",
      "switch-client",
      "-t",
      "=wux_attach",
    ]);
  });

  test("records an attach event before handing off to tmux", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("attach-life");
    let created = false;
    const calls: string[][] = [];

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const eventsPath = join(temp.stateHome, "wux", "runs", name, "events.jsonl");
      const runner = async (args: string[]): Promise<ProcessResult> => {
        calls.push(args);
        const events = await readFile(eventsPath, "utf8");
        expect(events).toContain('"type":"attach"');
        return { code: 0, stdout: "", stderr: "" };
      };

      await attachRun({ name, env: {} as NodeJS.ProcessEnv, runner });
      expect(calls).toEqual([["tmux", "attach-session", "-t", `=wux_${name}`]]);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("uses switch-client when invoked from inside tmux", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("attach-switch");
    let created = false;
    const calls: string[][] = [];

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      await attachRun({
        name,
        env: { TMUX: "/tmp/tmux-client" } as NodeJS.ProcessEnv,
        runner: async (args) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      });

      expect(calls).toEqual([["tmux", "switch-client", "-t", `=wux_${name}`]]);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("rejects missing, stopped, absent-session, and tmux handoff failures", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const stopped = uniqueRunName("attach-stopped");
    const dead = uniqueRunName("attach-dead");
    const failure = uniqueRunName("attach-failure");
    let stoppedCreated = false;
    let deadCreated = false;
    let failureCreated = false;

    try {
      await expect(attachRun({ name: "missing-attach", runner: async () => ({ code: 0, stdout: "", stderr: "" }) })).rejects.toThrow(
        "run not found",
      );

      await runCommand({ backend: "shell", name: stopped, cwd: temp.root });
      stoppedCreated = true;
      await saveRun({ ...(await loadRun(stopped)), status: "stopped" });
      await expect(attachRun({ name: stopped, runner: async () => ({ code: 0, stdout: "", stderr: "" }) })).rejects.toThrow(
        "run is stopped",
      );

      await runCommand({ backend: "shell", name: dead, cwd: temp.root });
      deadCreated = true;
      await killTmux(dead);
      deadCreated = false;
      await expect(attachRun({ name: dead, runner: async () => ({ code: 0, stdout: "", stderr: "" }) })).rejects.toThrow(
        "tmux session is not running",
      );

      await runCommand({ backend: "shell", name: failure, cwd: temp.root });
      failureCreated = true;
      await expect(attachRun({ name: failure, runner: async () => ({ code: 1, stdout: "", stderr: "no terminal" }) })).rejects.toThrow(
        "no terminal",
      );
    } finally {
      if (stoppedCreated) await killTmux(stopped);
      if (deadCreated) await killTmux(dead);
      if (failureCreated) await killTmux(failure);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("uses exact targets for tmux session existence smoke", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("attach-smoke");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      expect((await runProcess(["tmux", "has-session", "-t", `=wux_${name}`])).code).toBe(0);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});
