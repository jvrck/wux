import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../src/commands/run";
import { stopRun } from "../src/commands/stop";
import { deriveStatus } from "../src/commands/status";
import { loadRun } from "../src/runtime/runs";
import { hasSession } from "../src/runtime/tmux";
import { hasTmux, killTmux, tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("stop", () => {
  test("kills a live session with --yes and records stopped metadata and event", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("stop-yes");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const stopped = await stopRun({ name, yes: true });
      created = false;

      expect(await hasSession(`wux_${name}`)).toBe(false);
      expect(stopped.status).toBe("stopped");
      expect(stopped.stoppedAt).toEqual(expect.any(String));

      const meta = await loadRun(name);
      expect(meta.status).toBe("stopped");
      expect(meta.stoppedAt).toBe(stopped.stoppedAt);
      expect(meta.updatedAt).toBe(stopped.stoppedAt);

      const events = await readFile(join(temp.stateHome, "wux", "runs", name, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"stop"');
      expect(events).toContain(`"stoppedAt":"${stopped.stoppedAt}"`);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("requires and honors interactive confirmation", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const declined = uniqueRunName("stop-decline");
    const confirmed = uniqueRunName("stop-confirm");
    let declinedCreated = false;
    let confirmedCreated = false;
    let promptCount = 0;

    try {
      await runCommand({ backend: "shell", name: declined, cwd: temp.root });
      declinedCreated = true;
      await expect(
        stopRun({
          name: declined,
          yes: false,
          confirm: async () => {
            promptCount += 1;
            return false;
          },
        }),
      ).rejects.toThrow("stop cancelled");
      expect(promptCount).toBe(1);
      expect(await hasSession(`wux_${declined}`)).toBe(true);
      expect((await loadRun(declined)).status).toBe("running");

      await runCommand({ backend: "shell", name: confirmed, cwd: temp.root });
      confirmedCreated = true;
      await stopRun({
        name: confirmed,
        yes: false,
        confirm: async () => {
          promptCount += 1;
          return true;
        },
      });
      confirmedCreated = false;
      expect(promptCount).toBe(2);
      expect(await hasSession(`wux_${confirmed}`)).toBe(false);
      expect((await loadRun(confirmed)).status).toBe("stopped");
    } finally {
      if (declinedCreated) await killTmux(declined);
      if (confirmedCreated) await killTmux(confirmed);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("finalizes stopped when the tmux session vanished externally and exits success", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const dead = uniqueRunName("stop-dead");
    let deadCreated = false;

    try {
      await runCommand({ backend: "shell", name: dead, cwd: temp.root });
      deadCreated = true;
      // Kill the session out from under wux, as an external actor would.
      await killTmux(dead);
      deadCreated = false;
      expect(await hasSession(`wux_${dead}`)).toBe(false);

      const stopped = await stopRun({ name: dead, yes: true });
      expect(stopped.status).toBe("stopped");
      expect(stopped.stoppedAt).toEqual(expect.any(String));

      const meta = await loadRun(dead);
      expect(meta.status).toBe("stopped");
      expect(meta.stoppedAt).toBe(stopped.stoppedAt);
      expect(meta.updatedAt).toBe(stopped.stoppedAt);

      // status now derives `stopped`, not `unknown`.
      expect(deriveStatus(meta, await hasSession(meta.tmuxSession))).toBe("stopped");

      const events = await readFile(join(temp.stateHome, "wux", "runs", dead, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"stop"');
      expect(events).toContain(`"stoppedAt":"${stopped.stoppedAt}"`);
    } finally {
      if (deadCreated) await killTmux(dead);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("is a no-op success on an already-stopped run", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("stop-twice");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const first = await stopRun({ name, yes: true });
      created = false;
      expect(first.status).toBe("stopped");
      expect(await hasSession(`wux_${name}`)).toBe(false);

      // A second stop must succeed without touching state or appending another event.
      const eventsPath = join(temp.stateHome, "wux", "runs", name, "events.jsonl");
      const eventsBefore = await readFile(eventsPath, "utf8");
      const second = await stopRun({ name, yes: true });
      expect(second.status).toBe("stopped");
      expect(second.stoppedAt).toBe(first.stoppedAt);
      expect(second.updatedAt).toBe(first.updatedAt);
      expect(await readFile(eventsPath, "utf8")).toBe(eventsBefore);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("rejects missing runs and non-interactive unconfirmed live runs", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const unconfirmed = uniqueRunName("stop-unconfirmed");
    let unconfirmedCreated = false;

    try {
      await expect(stopRun({ name: "missing-stop", yes: true })).rejects.toThrow("run not found");

      await runCommand({ backend: "shell", name: unconfirmed, cwd: temp.root });
      unconfirmedCreated = true;
      await expect(stopRun({ name: unconfirmed, yes: false, inputIsTTY: false })).rejects.toThrow("use --yes");
      expect(await hasSession(`wux_${unconfirmed}`)).toBe(true);
      expect((await loadRun(unconfirmed)).status).toBe("running");
    } finally {
      if (unconfirmedCreated) await killTmux(unconfirmed);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});
