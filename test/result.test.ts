import { describe, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import {
  buildResultEnvelope,
  formatResultEnvelope,
  resultCommand,
  resultExitCode,
  waitResultEnvelope,
} from "../src/commands/result";
import { saveRun } from "../src/runtime/runs";
import { appendBackendSignal, appendEvent, appendWaitSettled } from "../src/runtime/events";
import { waitCommand } from "../src/commands/wait";
import { tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function withState<T>(fn: (stateHome: string, root: string) => Promise<T>): Promise<T> {
  const temp = await tempState();
  const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = temp.stateHome;
  try {
    return await fn(temp.stateHome, temp.root);
  } finally {
    process.env.XDG_STATE_HOME = old;
    await temp.cleanup();
  }
}

// Persist enough run state for a read-only `result` snapshot: meta.json (so
// loadRun succeeds) and a pane.log placeholder. No live tmux session is needed
// because `result` never touches tmux.
async function seedRun(
  stateHome: string,
  name: string,
  backend: "shell" | "claude" | "codex",
): Promise<string> {
  await saveRun({
    name,
    backend,
    tmuxSession: `wux_${name}`,
    cwd: "/tmp",
    owner: "tester@host",
    createdAt: "2026-06-08T00:00:00.000Z",
    status: "running",
  });
  const dir = join(stateHome, "wux", "runs", name);
  await writeFile(join(dir, "pane.log"), "pane output\n", "utf8");
  return dir;
}

describe("result", () => {
  test("composes an envelope from a claude turn-complete signal with lastAssistantMessage", async () => {
    await withState(async (stateHome) => {
      const name = "claude-done";
      const dir = await seedRun(stateHome, name, "claude");
      await appendBackendSignal(name, {
        signal: "turn-complete",
        at: "2026-06-08T01:00:00.000Z",
        turnId: "turn-42",
        lastAssistantMessage: "DONE",
      });

      const envelope = await resultCommand({ name });
      expect(envelope).toEqual({
        name,
        outcome: "done",
        completedVia: "hook",
        turnId: "turn-42",
        lastAssistantMessage: "DONE",
        signalAt: "2026-06-08T01:00:00.000Z",
        runDir: dir,
        paneLogPath: join(dir, "pane.log"),
        eventsPath: join(dir, "events.jsonl"),
        sentinelPath: join(dir, "turn-complete"),
      });
      expect(resultExitCode(envelope)).toBe(0);
    });
  });

  test("reports blocked with completedVia hook on an awaiting-approval signal", async () => {
    await withState(async (stateHome) => {
      const name = "codex-blocked";
      await seedRun(stateHome, name, "codex");
      await appendBackendSignal(name, {
        signal: "awaiting-approval",
        at: "2026-06-08T02:00:00.000Z",
        turnId: "turn-7",
        lastAssistantMessage: "Need approval to run rm",
      });

      const envelope = await resultCommand({ name });
      expect(envelope.outcome).toBe("blocked");
      expect(envelope.completedVia).toBe("hook");
      expect(envelope.lastAssistantMessage).toBe("Need approval to run rm");
      expect(envelope.turnId).toBe("turn-7");
      // blocked is nonzero so an autonomous loop branches away from "done".
      expect(resultExitCode(envelope)).toBe(1);
    });
  });

  test("resolves completedVia sentinel when only the turn-complete file exists", async () => {
    await withState(async (stateHome) => {
      const name = "codex-sentinel";
      const dir = await seedRun(stateHome, name, "codex");
      await writeFile(join(dir, "turn-complete"), "turn-complete 2026-06-08T03:00:00.000Z\n", "utf8");

      const envelope = await resultCommand({ name });
      expect(envelope.outcome).toBe("done");
      expect(envelope.completedVia).toBe("sentinel");
      // No backend-signal event was recorded, so there is no message/turnId.
      expect(envelope.lastAssistantMessage).toBeUndefined();
      expect(envelope.turnId).toBeUndefined();
      expect(envelope.signalAt).toBeUndefined();
      expect(envelope.sentinelPath).toBe(join(dir, "turn-complete"));
    });
  });

  test("shell run omits lastAssistantMessage/turnId and never fabricates a completion", async () => {
    await withState(async (stateHome) => {
      const name = "shell-run";
      const dir = await seedRun(stateHome, name, "shell");
      // Even a stray backend signal must be ignored for a shell backend.
      await appendBackendSignal(name, {
        signal: "turn-complete",
        at: "2026-06-08T04:00:00.000Z",
        turnId: "ignored",
        lastAssistantMessage: "ignored",
      });

      const envelope = await resultCommand({ name });
      expect(envelope.outcome).toBe("unknown");
      expect(envelope.completedVia).toBeUndefined();
      expect(envelope.lastAssistantMessage).toBeUndefined();
      expect(envelope.turnId).toBeUndefined();
      expect(envelope.signalAt).toBeUndefined();
      expect(envelope.runDir).toBe(dir);
      // unknown is nonzero.
      expect(resultExitCode(envelope)).toBe(1);
    });
  });

  test("ignores a stale signal from before the latest turn input", async () => {
    await withState(async (stateHome) => {
      const name = "claude-stale";
      const dir = await seedRun(stateHome, name, "claude");
      await appendBackendSignal(name, {
        signal: "turn-complete",
        at: "2026-06-08T05:00:00.000Z",
        turnId: "old-turn",
        lastAssistantMessage: "previous answer",
      });
      const staleAt = new Date("2026-06-08T05:00:00.000Z");
      await utimes(join(dir, "turn-complete"), staleAt, staleAt);
      // A newer send means the recorded completion belongs to a previous turn.
      await appendEvent(name, { type: "send", at: "2026-06-08T05:00:01.000Z", bytes: 4 });

      const envelope = await resultCommand({ name });
      expect(envelope.outcome).toBe("unknown");
      expect(envelope.completedVia).toBeUndefined();
      expect(envelope.lastAssistantMessage).toBeUndefined();
    });
  });

  test("envelope pointers are present and point inside the run directory", async () => {
    await withState(async (stateHome) => {
      const name = "pointer-check";
      const dir = await seedRun(stateHome, name, "claude");

      const envelope = await resultCommand({ name });
      expect(envelope.runDir).toBe(dir);
      expect(envelope.paneLogPath).toBe(join(dir, "pane.log"));
      expect(envelope.eventsPath).toBe(join(dir, "events.jsonl"));
      expect(envelope.paneLogPath.startsWith(dir)).toBe(true);
      expect(envelope.eventsPath.startsWith(dir)).toBe(true);
      // No turn-complete file was written, so the sentinel pointer is omitted.
      expect(envelope.sentinelPath).toBeUndefined();
    });
  });

  test("rejects a missing run name", async () => {
    await expect(resultCommand({ name: "" })).rejects.toThrow("result requires <run-name>");
  });

  test("CLI: unknown run prints the shared error envelope on stdout and exits nonzero", async () => {
    await withState(async () => {
      const memory = memoryIO();
      const code = await runCli(["--local", "result", "no-such-run-xyz", "--json"], memory.io);
      expect(code).toBe(1);
      expect(memory.output().stderr).toBe("");
      expect(JSON.parse(memory.output().stdout)).toEqual({
        error: { code: "run-not-found", message: "run not found: no-such-run-xyz" },
      });

      // Stable across calls.
      const second = memoryIO();
      const codeAgain = await runCli(["--local", "result", "no-such-run-xyz", "--json"], second.io);
      expect(codeAgain).toBe(1);
      expect(JSON.parse(second.output().stdout)).toEqual({
        error: { code: "run-not-found", message: "run not found: no-such-run-xyz" },
      });
    });
  });

  test("CLI: result --json exits 0 and prints the envelope for a completed claude run", async () => {
    await withState(async (stateHome) => {
      const name = uniqueRunName("result-cli-done");
      const dir = await seedRun(stateHome, name, "claude");
      await appendBackendSignal(name, {
        signal: "turn-complete",
        at: "2026-06-08T06:00:00.000Z",
        turnId: "turn-99",
        lastAssistantMessage: "all green",
      });

      const memory = memoryIO();
      const code = await runCli(["--local", "result", name, "--json"], memory.io);
      expect(code).toBe(0);
      expect(memory.output().stderr).toBe("");
      expect(JSON.parse(memory.output().stdout)).toEqual({
        name,
        outcome: "done",
        completedVia: "hook",
        turnId: "turn-99",
        lastAssistantMessage: "all green",
        signalAt: "2026-06-08T06:00:00.000Z",
        runDir: dir,
        paneLogPath: join(dir, "pane.log"),
        eventsPath: join(dir, "events.jsonl"),
        sentinelPath: join(dir, "turn-complete"),
      });
    });
  });

  test("CLI: result --json exits nonzero for an unknown-outcome shell run", async () => {
    await withState(async (stateHome) => {
      const name = uniqueRunName("result-cli-shell");
      await seedRun(stateHome, name, "shell");

      const memory = memoryIO();
      const code = await runCli(["--local", "result", name, "--json"], memory.io);
      expect(code).toBe(1);
      const envelope = JSON.parse(memory.output().stdout);
      expect(envelope.outcome).toBe("unknown");
      expect(envelope.lastAssistantMessage).toBeUndefined();
      expect(envelope.turnId).toBeUndefined();
    });
  });

  test("CLI: result rejects unknown options and stray arguments", async () => {
    const bad = memoryIO();
    expect(await runCli(["--local", "result", "r", "--bogus"], bad.io)).toBe(1);
    expect(bad.output().stderr).toBe("wux: unknown option: --bogus\n");

    const extra = memoryIO();
    expect(await runCli(["--local", "result", "r", "trailing"], extra.io)).toBe(1);
    expect(extra.output().stderr).toBe("wux: unexpected argument: trailing\n");
  });

  test("CLI: result --help documents the envelope and the no-connectors boundary", async () => {
    const memory = memoryIO();
    const code = await runCli(["result", "--help"], memory.io);
    expect(code).toBe(0);
    expect(memory.output().stdout).toContain("wux result <run-name>");
    expect(memory.output().stdout).toContain("eventsPath");
    expect(memory.output().stdout).toContain("no git/gh/test/PR connectors");
  });

  test("non-json result prints a terse human summary plus pointers", async () => {
    await withState(async (stateHome) => {
      const name = uniqueRunName("result-text");
      const dir = await seedRun(stateHome, name, "claude");
      await appendBackendSignal(name, {
        signal: "turn-complete",
        at: "2026-06-08T07:00:00.000Z",
        lastAssistantMessage: "wrote PR",
      });

      const memory = memoryIO();
      const code = await runCli(["--local", "result", name], memory.io);
      expect(code).toBe(0);
      const out = memory.output().stdout;
      expect(out).toContain(`result ${name}: done (hook)`);
      expect(out).toContain("lastAssistantMessage: wrote PR");
      expect(out).toContain(`runDir: ${dir}`);
    });
  });

  test("wait --result inlines an envelope using wait's authoritative outcome", async () => {
    await withState(async (stateHome) => {
      const name = "shell-quiescent";
      await seedRun(stateHome, name, "shell");
      // Simulate wait's blocking resolution: quiescence is something only wait can
      // observe; the inlined envelope must carry it, not the snapshot's unknown.
      const waitResult = {
        name,
        outcome: "done" as const,
        completedVia: "quiescence" as const,
        idleMs: 1000,
        timeoutMs: 30000,
        waitedMs: 1000,
        pollIntervalMs: 250,
      };
      const envelope = await waitResultEnvelope(waitResult);
      expect(envelope.outcome).toBe("done");
      expect(envelope.completedVia).toBe("quiescence");
      // Shell run: no fabricated message even though wait said done.
      expect(envelope.lastAssistantMessage).toBeUndefined();
      expect(envelope.turnId).toBeUndefined();
    });
  });

  test("wait --result omits a stale pre-send signal on a claude run", async () => {
    await withState(async (stateHome) => {
      // A claude turn completes (turn-complete recorded), then the operator sends
      // a new turn. wait resolves the CURRENT turn via quiescence/timeout with no
      // fresh hook/sentinel. The inlined envelope must NOT dredge up the prior
      // turn's message/turnId — it applies the same turn-scoped freshness filter
      // as the standalone `result` path. A shell backend short-circuits the reader
      // and would mask this divergence, so this uses a claude backend.
      const name = "claude-wait-stale";
      const dir = await seedRun(stateHome, name, "claude");
      await appendBackendSignal(name, {
        signal: "turn-complete",
        at: "2026-06-08T05:00:00.000Z",
        turnId: "old-turn",
        lastAssistantMessage: "answer 1",
      });
      const staleAt = new Date("2026-06-08T05:00:00.000Z");
      await utimes(join(dir, "turn-complete"), staleAt, staleAt);
      // Newer send: the recorded completion belongs to the previous turn.
      await appendEvent(name, { type: "send", at: "2026-06-08T05:00:01.000Z", bytes: 4 });

      // wait resolved the current turn via quiescence (no fresh signal observed).
      const waitResult = {
        name,
        outcome: "done" as const,
        completedVia: "quiescence" as const,
        idleMs: 1000,
        timeoutMs: 30000,
        waitedMs: 1000,
        pollIntervalMs: 250,
      };
      const envelope = await waitResultEnvelope(waitResult);
      expect(envelope.outcome).toBe("done");
      expect(envelope.completedVia).toBe("quiescence");
      // Stale prior-turn signal must be omitted, matching `wux result`.
      expect(envelope.lastAssistantMessage).toBeUndefined();
      expect(envelope.turnId).toBeUndefined();
      expect(envelope.signalAt).toBeUndefined();

      // The inlined envelope's signal fields match what standalone `result` reports.
      const standalone = await resultCommand({ name });
      expect(envelope.lastAssistantMessage).toBe(standalone.lastAssistantMessage);
      expect(envelope.turnId).toBe(standalone.turnId);
      expect(envelope.signalAt).toBe(standalone.signalAt);
    });
  });

  test("CLI: wait --result requires --json", async () => {
    const memory = memoryIO();
    const code = await runCli(["--local", "wait", "r", "--result"], memory.io);
    expect(code).toBe(1);
    expect(memory.output().stderr).toBe("wux: --result requires --json\n");
  });

  test("shell run: a persisted wait-settled quiescence outcome is replayed (not unknown)", async () => {
    await withState(async (stateHome) => {
      const name = "shell-settled-done";
      const dir = await seedRun(stateHome, name, "shell");
      // wait resolved this shell turn via quiescence and persisted it. result must
      // surface done/quiescence — the headline #136 fix — not fall through to unknown.
      await appendWaitSettled(name, { outcome: "done", completedVia: "quiescence", sinceInputAt: null });

      const envelope = await resultCommand({ name });
      expect(envelope.outcome).toBe("done");
      expect(envelope.completedVia).toBe("quiescence");
      // Schema unchanged: a shell run still carries no turnId/lastAssistantMessage.
      expect(envelope.turnId).toBeUndefined();
      expect(envelope.lastAssistantMessage).toBeUndefined();
      expect(envelope.signalAt).toBeUndefined();
      expect(envelope.runDir).toBe(dir);
      expect(resultExitCode(envelope)).toBe(0);
    });
  });

  test("end-to-end: wux wait (shell) then wux result agree on done/quiescence", async () => {
    await withState(async (stateHome) => {
      const name = "shell-e2e-agree";
      await seedRun(stateHome, name, "shell");
      // A controllable fake clock: sleep advances time so the idle window elapses.
      let current = 0;

      // Drive the real waitCommand persistence path (no appendSettled injection),
      // so it writes a wait-settled event that resultCommand then reads back.
      const waitResult = await waitCommand({
        name,
        idleMs: 500,
        timeoutMs: 2_000,
        pollIntervalMs: 250,
        now: () => current,
        sleep: async (ms: number) => {
          current += ms;
        },
        loadRun: async () => ({ name, tmuxSession: `wux_${name}`, backend: "shell" }),
        hasSession: async () => true,
        capturePane: async () => "stable\n",
      });
      expect(waitResult.outcome).toBe("done");
      expect(waitResult.completedVia).toBe("quiescence");

      const envelope = await resultCommand({ name });
      expect(envelope.outcome).toBe(waitResult.outcome);
      expect(envelope.completedVia).toBe(waitResult.completedVia);
      expect(envelope.outcome).toBe("done");
      expect(envelope.completedVia).toBe("quiescence");
    });
  });

  test("never-waited shell run with no persisted settle still reports unknown (no fabrication)", async () => {
    await withState(async (stateHome) => {
      const name = "shell-never-waited";
      await seedRun(stateHome, name, "shell");
      // No wait-settled record was ever written, and no live tmux session exists.
      const envelope = await resultCommand({ name });
      expect(envelope.outcome).toBe("unknown");
      expect(envelope.completedVia).toBeUndefined();
      expect(resultExitCode(envelope)).toBe(1);
    });
  });

  test("a timeout settle resolved by wait is reflected by a later result", async () => {
    await withState(async (stateHome) => {
      const name = "shell-settled-timeout";
      await seedRun(stateHome, name, "shell");
      await appendWaitSettled(name, { outcome: "timeout", sinceInputAt: null });

      const envelope = await resultCommand({ name });
      expect(envelope.outcome).toBe("timeout");
      expect(envelope.completedVia).toBeUndefined();
      // timeout is nonzero so a loop branches away from done.
      expect(resultExitCode(envelope)).toBe(1);
    });
  });

  test("a persisted settle older than the latest send/interrupt is treated as stale", async () => {
    await withState(async (stateHome) => {
      const name = "shell-settled-stale";
      await seedRun(stateHome, name, "shell");
      // wait settled the prior turn against an earlier send...
      await appendEvent(name, { type: "send", at: "2026-06-08T08:00:00.000Z", bytes: 4 });
      await appendWaitSettled(name, { outcome: "done", completedVia: "quiescence", sinceInputAt: "2026-06-08T08:00:00.000Z" });
      // ...then a newer send started a fresh, unsettled turn.
      await appendEvent(name, { type: "send", at: "2026-06-08T08:00:10.000Z", bytes: 4 });

      const envelope = await resultCommand({ name });
      expect(envelope.outcome).toBe("unknown");
      expect(envelope.completedVia).toBeUndefined();
    });
  });

  test("claude run: a fresh hook still wins over any persisted settle (claude/codex unchanged)", async () => {
    await withState(async (stateHome) => {
      const name = "claude-hook-wins";
      const dir = await seedRun(stateHome, name, "claude");
      // Even if a settle was persisted, the live hook ladder runs first for claude.
      await appendWaitSettled(name, { outcome: "timeout", sinceInputAt: null });
      await appendBackendSignal(name, {
        signal: "turn-complete",
        at: "2026-06-08T09:00:00.000Z",
        turnId: "turn-100",
        lastAssistantMessage: "hooked done",
      });

      const envelope = await resultCommand({ name });
      expect(envelope.outcome).toBe("done");
      expect(envelope.completedVia).toBe("hook");
      expect(envelope.turnId).toBe("turn-100");
      expect(envelope.lastAssistantMessage).toBe("hooked done");
      expect(envelope.sentinelPath).toBe(join(dir, "turn-complete"));
    });
  });

  test("buildResultEnvelope omits the sentinel pointer when no turn-complete file exists", async () => {
    await withState(async (stateHome) => {
      const name = "no-sentinel";
      const dir = join(stateHome, "wux", "runs", name);
      await mkdir(dir, { recursive: true });
      const envelope = buildResultEnvelope(name, "timeout", undefined, undefined);
      expect(envelope).toEqual({
        name,
        outcome: "timeout",
        runDir: dir,
        paneLogPath: join(dir, "pane.log"),
        eventsPath: join(dir, "events.jsonl"),
      });
      // formatResultEnvelope on a bare timeout envelope still renders pointers.
      const text = formatResultEnvelope(envelope);
      expect(text).toContain(`result ${name}: timeout`);
      expect(text).toContain(`eventsPath: ${join(dir, "events.jsonl")}`);
    });
  });
});
