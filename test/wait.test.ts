import { describe, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { probeHookSignal, probeSentinelSignal, waitCommand } from "../src/commands/wait";
import { runCommand } from "../src/commands/run";
import { sendCommand } from "../src/commands/send";
import { appendBackendSignal, appendEvent, readWaitSettled } from "../src/runtime/events";
import { interruptSession, paneForegroundActivity } from "../src/runtime/tmux";
import { hasTmux, killTmux, tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Poll the real foreground-activity probe until a silent-but-busy child owns the
// pane's tty foreground (prompt has NOT returned), bounded by a generous timeout.
// Between "command keystrokes delivered" and "the child is actually the pane's
// foreground command" the probe still reads the shell as foreground (idle); a
// loaded CI runner widens that window. Gating the live silent-busy assertion on
// this precondition removes the foreground-grab race without touching the probe
// or `wait`'s quiescence semantics. Throws if the child never grabs foreground so
// the test fails loudly rather than silently asserting against a wrong state.
async function awaitForegroundBusy(session: string, timeoutMs = 5_000, pollMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await paneForegroundActivity(session)) === "foreground-busy") return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`pane ${session} never reached foreground-busy within ${timeoutMs}ms`);
}

function memoryIO() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    output: () => ({ stdout, stderr }),
  };
}

function clock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

describe("wait", () => {
  test("returns quiescence after the frame hash is stable for the idle window", async () => {
    const time = clock();
    const captures: string[] = [];

    const result = await waitCommand({
      name: "settled",
      idleMs: 500,
      timeoutMs: 2_000,
      pollIntervalMs: 250,
      now: time.now,
      sleep: time.sleep,
      loadRun: async () => ({ name: "settled", tmuxSession: "wux_settled", backend: "shell" }),
      hasSession: async () => true,
      capturePane: async () => {
        captures.push("capture");
        return "stable frame\n";
      },
      appendSettled: async () => undefined,
      readTurnInputAt: async () => null,
    });

    expect(result).toEqual({
      name: "settled",
      outcome: "done",
      completedVia: "quiescence",
      idleMs: 500,
      timeoutMs: 2_000,
      waitedMs: 500,
      pollIntervalMs: 250,
    });
    expect(captures.length).toBe(3);
  });

  test("a silent-but-busy shell run never resolves done via quiescence; it times out", async () => {
    const time = clock();
    const activityCalls: string[] = [];

    const result = await waitCommand({
      name: "silent-busy",
      idleMs: 2_000,
      timeoutMs: 6_000,
      pollIntervalMs: 250,
      now: time.now,
      sleep: time.sleep,
      loadRun: async () => ({ name: "silent-busy", tmuxSession: "wux_silent_busy", backend: "shell" }),
      hasSession: async () => true,
      // The pane is byte-static (a busy child writes nothing to the pane), so the
      // frame hash never changes — quiescence alone would falsely declare done.
      capturePane: async () => "static frame while yes > /dev/null runs\n",
      // The foreground-process probe reports the child is still running.
      paneActivity: async (session) => {
        activityCalls.push(session);
        return "foreground-busy";
      },
      appendSettled: async () => undefined,
      readTurnInputAt: async () => null,
    });

    expect(result.outcome).toBe("timeout");
    expect(result.completedVia).toBeUndefined();
    expect(result.name).toBe("silent-busy");
    // The probe gates quiescence, so it must have been consulted at least once.
    expect(activityCalls.length).toBeGreaterThan(0);
    expect(activityCalls.every((s) => s === "wux_silent_busy")).toBe(true);
  });

  test("a genuinely idle shell run still resolves done/quiescence (no regression)", async () => {
    const time = clock();
    let activityCalls = 0;

    const result = await waitCommand({
      name: "settled-shell",
      idleMs: 500,
      timeoutMs: 6_000,
      pollIntervalMs: 250,
      now: time.now,
      sleep: time.sleep,
      loadRun: async () => ({ name: "settled-shell", tmuxSession: "wux_settled_shell", backend: "shell" }),
      hasSession: async () => true,
      capturePane: async () => "prompt is back\n",
      paneActivity: async () => {
        activityCalls += 1;
        return "idle";
      },
      appendSettled: async () => undefined,
      readTurnInputAt: async () => null,
    });

    expect(result).toMatchObject({ name: "settled-shell", outcome: "done", completedVia: "quiescence" });
    // The probe is only consulted once the idle window is reached, not every poll.
    expect(activityCalls).toBe(1);
  });

  test("an unknown pane-activity probe does not block quiescence (probe-failure fallback)", async () => {
    const time = clock();

    const result = await waitCommand({
      name: "probe-unknown",
      idleMs: 500,
      timeoutMs: 6_000,
      pollIntervalMs: 250,
      now: time.now,
      sleep: time.sleep,
      loadRun: async () => ({ name: "probe-unknown", tmuxSession: "wux_probe_unknown", backend: "shell" }),
      hasSession: async () => true,
      capturePane: async () => "static\n",
      // Probe can't determine state (no ps, weird platform): fall back to the
      // pre-existing pane-quiescence behavior rather than hang forever.
      paneActivity: async () => "unknown",
      appendSettled: async () => undefined,
      readTurnInputAt: async () => null,
    });

    expect(result).toMatchObject({ name: "probe-unknown", outcome: "done", completedVia: "quiescence" });
  });

  test("the pane-activity probe is not consulted for claude/codex quiescence", async () => {
    const time = clock();
    let activityCalls = 0;

    const result = await waitCommand({
      name: "codex-quiet",
      idleMs: 500,
      timeoutMs: 6_000,
      pollIntervalMs: 250,
      now: time.now,
      sleep: time.sleep,
      loadRun: async () => ({ name: "codex-quiet", tmuxSession: "wux_codex_quiet", backend: "codex" }),
      hasSession: async () => true,
      capturePane: async () => "idle composer\n",
      paneActivity: async () => {
        activityCalls += 1;
        return "foreground-busy";
      },
      appendSettled: async () => undefined,
      readTurnInputAt: async () => null,
    });

    // claude/codex ladder behavior is unchanged: the shell-only probe is skipped.
    expect(result).toMatchObject({ name: "codex-quiet", outcome: "done", completedVia: "quiescence" });
    expect(activityCalls).toBe(0);
  });

  test("times out without completedVia when frames keep changing", async () => {
    const time = clock();
    let frame = 0;

    const result = await waitCommand({
      name: "busy",
      idleMs: 500,
      timeoutMs: 750,
      pollIntervalMs: 250,
      now: time.now,
      sleep: time.sleep,
      loadRun: async () => ({ name: "busy", tmuxSession: "wux_busy", backend: "shell" }),
      hasSession: async () => true,
      capturePane: async () => `frame ${frame++}\n`,
      appendSettled: async () => undefined,
      readTurnInputAt: async () => null,
    });

    expect(result).toEqual({
      name: "busy",
      outcome: "timeout",
      idleMs: 500,
      timeoutMs: 750,
      waitedMs: 750,
      pollIntervalMs: 250,
    });
    expect(result.completedVia).toBeUndefined();
  });

  test("returns unknown without completedVia when the tmux session disappears without a signal", async () => {
    const time = clock();
    let captured = false;

    const result = await waitCommand({
      name: "gone",
      idleMs: 500,
      timeoutMs: 2_000,
      pollIntervalMs: 250,
      now: time.now,
      sleep: time.sleep,
      loadRun: async () => ({ name: "gone", tmuxSession: "wux_gone", backend: "codex" }),
      hasSession: async () => false,
      capturePane: async () => {
        captured = true;
        return "should not capture\n";
      },
    });

    expect(result).toEqual({
      name: "gone",
      outcome: "unknown",
      idleMs: 500,
      timeoutMs: 2_000,
      waitedMs: 0,
      pollIntervalMs: 250,
    });
    expect(result.completedVia).toBeUndefined();
    expect(captured).toBe(false);
  });

  test("returns hook when a turn-complete backend signal exists", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const time = clock();

    try {
      await appendBackendSignal("hooked", { signal: "turn-complete", at: "2026-06-08T00:00:00.000Z" });
      const result = await waitCommand({
        name: "hooked",
        idleMs: 500,
        timeoutMs: 2_000,
        pollIntervalMs: 250,
        now: time.now,
        sleep: time.sleep,
        loadRun: async () => ({ name: "hooked", tmuxSession: "wux_hooked", backend: "claude" }),
        hasSession: async () => true,
        capturePane: async () => {
          throw new Error("hook should win before capture");
        },
      });

      expect(result).toEqual({
        name: "hooked",
        outcome: "done",
        completedVia: "hook",
        idleMs: 500,
        timeoutMs: 2_000,
        waitedMs: 0,
        pollIntervalMs: 250,
      });
      expect(await probeHookSignal("hooked")).toBe("hook");
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("returns blocked when an awaiting-approval backend signal exists", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const time = clock();

    try {
      await appendBackendSignal("approval", { signal: "awaiting-approval", at: "2026-06-08T00:00:00.000Z" });
      const result = await waitCommand({
        name: "approval",
        idleMs: 500,
        timeoutMs: 2_000,
        pollIntervalMs: 250,
        now: time.now,
        sleep: time.sleep,
        loadRun: async () => ({ name: "approval", tmuxSession: "wux_approval", backend: "codex" }),
        hasSession: async () => true,
        capturePane: async () => "stable\n",
      });

      expect(result).toEqual({
        name: "approval",
        outcome: "blocked",
        completedVia: "hook",
        idleMs: 500,
        timeoutMs: 2_000,
        waitedMs: 0,
        pollIntervalMs: 250,
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("returns sentinel when only the turn-complete sentinel file exists", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const time = clock();

    try {
      const dir = join(temp.stateHome, "wux", "runs", "sentinel");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "turn-complete"), "2026-06-08T00:00:00.000Z\n", "utf8");

      const result = await waitCommand({
        name: "sentinel",
        idleMs: 500,
        timeoutMs: 2_000,
        pollIntervalMs: 250,
        now: time.now,
        sleep: time.sleep,
        loadRun: async () => ({ name: "sentinel", tmuxSession: "wux_sentinel", backend: "claude" }),
        hasSession: async () => true,
        capturePane: async () => {
          throw new Error("sentinel should win before capture");
        },
      });

      expect(result).toEqual({
        name: "sentinel",
        outcome: "done",
        completedVia: "sentinel",
        idleMs: 500,
        timeoutMs: 2_000,
        waitedMs: 0,
        pollIntervalMs: 250,
      });
      expect(await probeSentinelSignal("sentinel")).toBe("sentinel");
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("shell backend ignores hook and sentinel signals and only reports quiescence", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const time = clock();

    try {
      await appendBackendSignal("shell-hook", { signal: "turn-complete", at: "2026-06-08T00:00:00.000Z" });
      const result = await waitCommand({
        name: "shell-hook",
        idleMs: 500,
        timeoutMs: 2_000,
        pollIntervalMs: 250,
        now: time.now,
        sleep: time.sleep,
        loadRun: async () => ({ name: "shell-hook", tmuxSession: "wux_shell_hook", backend: "shell" }),
        hasSession: async () => true,
        capturePane: async () => "stable shell\n",
      });

      expect(result).toMatchObject({
        name: "shell-hook",
        outcome: "done",
        completedVia: "quiescence",
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("ignores hook and sentinel signals older than the latest turn input", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const time = clock();

    try {
      await appendBackendSignal("stale-hook", { signal: "turn-complete", at: "2026-06-08T00:00:00.000Z" });
      const staleAt = new Date("2026-06-08T00:00:00.000Z");
      await utimes(join(temp.stateHome, "wux", "runs", "stale-hook", "turn-complete"), staleAt, staleAt);
      await appendEvent("stale-hook", { type: "send", at: "2026-06-08T00:00:01.000Z", bytes: 5 });

      expect(await probeHookSignal("stale-hook")).toBeUndefined();
      expect(await probeSentinelSignal("stale-hook", "2026-06-08T00:00:01.000Z")).toBeUndefined();

      const result = await waitCommand({
        name: "stale-hook",
        idleMs: 500,
        timeoutMs: 2_000,
        pollIntervalMs: 250,
        now: time.now,
        sleep: time.sleep,
        loadRun: async () => ({ name: "stale-hook", tmuxSession: "wux_stale_hook", backend: "claude" }),
        hasSession: async () => true,
        capturePane: async () => "stable after stale hook\n",
      });

      expect(result).toMatchObject({
        name: "stale-hook",
        outcome: "done",
        completedVia: "quiescence",
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("persists a wait-settled record so a later result snapshot can replay the outcome", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const time = clock();

    try {
      // A shell turn was sent, then wait resolves it via quiescence.
      await appendEvent("settle-persist", { type: "send", at: "2026-06-08T00:00:00.000Z", bytes: 4 });
      const result = await waitCommand({
        name: "settle-persist",
        idleMs: 500,
        timeoutMs: 2_000,
        pollIntervalMs: 250,
        now: time.now,
        sleep: time.sleep,
        loadRun: async () => ({ name: "settle-persist", tmuxSession: "wux_settle_persist", backend: "shell" }),
        hasSession: async () => true,
        capturePane: async () => "stable frame\n",
      });
      expect(result).toMatchObject({ outcome: "done", completedVia: "quiescence" });

      // The settle is persisted and current (recorded against the latest send).
      const settled = await readWaitSettled("settle-persist");
      expect(settled).toMatchObject({
        type: "wait-settled",
        outcome: "done",
        completedVia: "quiescence",
        sinceInputAt: "2026-06-08T00:00:00.000Z",
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("a newer send after a persisted settle makes the settle stale (readWaitSettled returns undefined)", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const time = clock();

    try {
      await appendEvent("settle-stale", { type: "send", at: "2026-06-08T00:00:00.000Z", bytes: 4 });
      await waitCommand({
        name: "settle-stale",
        idleMs: 500,
        timeoutMs: 2_000,
        pollIntervalMs: 250,
        now: time.now,
        sleep: time.sleep,
        loadRun: async () => ({ name: "settle-stale", tmuxSession: "wux_settle_stale", backend: "shell" }),
        hasSession: async () => true,
        capturePane: async () => "stable frame\n",
      });
      // The record is current immediately after wait.
      expect(await readWaitSettled("settle-stale")).toMatchObject({ outcome: "done" });

      // A newer send starts a fresh, unsettled turn — the prior settle is stale.
      await appendEvent("settle-stale", { type: "send", at: "2026-06-08T00:00:05.000Z", bytes: 4 });
      expect(await readWaitSettled("settle-stale")).toBeUndefined();
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("a timeout settle is persisted and replayable (not only done)", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const time = clock();
    let frame = 0;

    try {
      const result = await waitCommand({
        name: "settle-timeout",
        idleMs: 500,
        timeoutMs: 750,
        pollIntervalMs: 250,
        now: time.now,
        sleep: time.sleep,
        loadRun: async () => ({ name: "settle-timeout", tmuxSession: "wux_settle_timeout", backend: "shell" }),
        hasSession: async () => true,
        capturePane: async () => `frame ${frame++}\n`,
      });
      expect(result.outcome).toBe("timeout");

      const settled = await readWaitSettled("settle-timeout");
      expect(settled).toMatchObject({ type: "wait-settled", outcome: "timeout", sinceInputAt: null });
      expect(settled?.completedVia).toBeUndefined();
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("an unknown outcome (session gone, no signal) is NOT persisted (no fabrication)", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const time = clock();

    try {
      const result = await waitCommand({
        name: "settle-unknown",
        idleMs: 500,
        timeoutMs: 2_000,
        pollIntervalMs: 250,
        now: time.now,
        sleep: time.sleep,
        loadRun: async () => ({ name: "settle-unknown", tmuxSession: "wux_settle_unknown", backend: "codex" }),
        hasSession: async () => false,
        capturePane: async () => "unreached\n",
      });
      expect(result.outcome).toBe("unknown");
      // Nothing persisted: a never-completed run must keep reporting unknown.
      expect(await readWaitSettled("settle-unknown")).toBeUndefined();
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("validates timing options", async () => {
    await expect(waitCommand({ name: "", idleMs: 500 })).rejects.toThrow("wait requires");
    await expect(waitCommand({ name: "bad", idleMs: 0 })).rejects.toThrow("--idle");
    await expect(waitCommand({ name: "bad", timeoutMs: 0 })).rejects.toThrow("--timeout");
    await expect(waitCommand({ name: "bad", pollIntervalMs: 0 })).rejects.toThrow("--poll-interval-ms");
  });

  test("CLI wait --json exits zero for a quiescent shell run", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("wait-cli");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;

      const memory = memoryIO();
      const code = await runCli(["--local", "wait", name, "--idle", "250ms", "--timeout", "5s", "--poll-interval-ms", "100", "--json"], memory.io);
      expect(code).toBe(0);
      expect(memory.output().stderr).toBe("");
      expect(JSON.parse(memory.output().stdout)).toMatchObject({
        name,
        outcome: "done",
        completedVia: "quiescence",
        idleMs: 250,
        timeoutMs: 5_000,
        pollIntervalMs: 100,
      });
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("a real silent-busy shell run (yes > /dev/null) resolves timeout, never done", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("wait-silentbusy");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      // Silent-but-busy: the pane goes byte-static while the process spins.
      await sendCommand({ name, text: "yes > /dev/null", forceOwner: false });
      // Deterministic precondition: wait until `yes` actually owns the pane's tty
      // foreground (probe === "foreground-busy") before starting `wait`, so the
      // run cannot accumulate quiescence against the brief shell-foreground window
      // a loaded runner widens. Mirrors real-world truth (a not-yet-started command
      // is momentarily idle) — the fix is in the test setup, not the probe.
      await awaitForegroundBusy(`wux_${name}`);

      const result = await waitCommand({ name, idleMs: 2_000, timeoutMs: 6_000, pollIntervalMs: 250 });
      expect(result.outcome).toBe("timeout");
      expect(result.completedVia).toBeUndefined();
    } finally {
      if (created) {
        await interruptSession(`wux_${name}`).catch(() => undefined);
        await killTmux(name);
      }
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  }, 15_000);

  test("a real idle shell run resolves done/quiescence (live no-regression)", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("wait-liveidle");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      // A command that finishes quickly and returns the prompt.
      await sendCommand({ name, text: "echo done-now", forceOwner: false });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const result = await waitCommand({ name, idleMs: 500, timeoutMs: 6_000, pollIntervalMs: 100 });
      expect(result).toMatchObject({ name, outcome: "done", completedVia: "quiescence" });
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  }, 15_000);
});
