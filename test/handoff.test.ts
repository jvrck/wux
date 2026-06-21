import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handoffRun, loadHandoffPrompt } from "../src/commands/handoff";
import { runCommand } from "../src/commands/run";
import { sendCommand } from "../src/commands/send";
import { DEFAULT_HANDOFF_PROMPT, DEFAULT_HANDOFF_TAIL, DEFAULT_HANDOFF_WAIT_MS } from "../src/runtime/prompts";
import type { WaitResult } from "../src/commands/wait";
import { hasTmux, killTmux, tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// A `wait` stand-in that resolves `done` immediately. Records the timeout it was
// handed so tests can assert `--wait-ms` flows through as the upper bound.
function stubWait(record?: { timeoutMs?: number }): (timeoutMs: number) => Promise<WaitResult> {
  return async (timeoutMs: number) => {
    if (record) record.timeoutMs = timeoutMs;
    return {
      name: "stub",
      outcome: "done",
      completedVia: "quiescence",
      idleMs: 1_000,
      timeoutMs,
      waitedMs: 42,
      pollIntervalMs: 250,
    };
  };
}

describe("handoff", () => {
  test("default prompt includes required handoff sections", async () => {
    expect(DEFAULT_HANDOFF_PROMPT).toContain("current state");
    expect(DEFAULT_HANDOFF_PROMPT).toContain("what changed");
    expect(DEFAULT_HANDOFF_PROMPT).toContain("blockers or approvals needed");
    expect(DEFAULT_HANDOFF_PROMPT).toContain("files, commands, and links worth preserving");
    expect(DEFAULT_HANDOFF_PROMPT).toContain("next action");
    expect(await loadHandoffPrompt()).toBe(DEFAULT_HANDOFF_PROMPT);
  });

  test("default wait-ms is a realistic upper bound, not a 1s fixed sleep", () => {
    // Regression for eval S15 (2026-06-08): the old 1000ms default reliably
    // captured a half-rendered `Working` frame for real claude/codex turns.
    expect(DEFAULT_HANDOFF_WAIT_MS).toBeGreaterThanOrEqual(15_000);
    expect(DEFAULT_HANDOFF_WAIT_MS).not.toBe(1_000);
  });

  test("uses prompt-file content instead of the default prompt", async () => {
    const temp = await tempState();
    const promptFile = join(temp.root, "handoff.md");
    try {
      await writeFile(promptFile, "printf 'handoff-file-prompt-ok\\n'\n", "utf8");
      expect(await loadHandoffPrompt(promptFile)).toBe("printf 'handoff-file-prompt-ok\\n'\n");
      await writeFile(promptFile, "", "utf8");
      await expect(loadHandoffPrompt(promptFile)).rejects.toThrow("prompt is empty");
    } finally {
      await temp.cleanup();
    }
  });

  test("sends prompt-file content, captures output, and appends handoff event", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("handoff-file");
    const promptFile = join(temp.root, "handoff.md");
    let created = false;

    try {
      await writeFile(promptFile, "printf 'wux-handoff-file-ok\\n'\n", "utf8");
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;

      const record: { timeoutMs?: number } = {};
      const output = await handoffRun({ name, promptFile, waitMs: 500, tail: 50, wait: stubWait(record) });
      expect(output).toContain("wux-handoff-file-ok");
      // `--wait-ms` flows through to the settle as its timeout (upper bound).
      expect(record.timeoutMs).toBe(500);

      const events = await readFile(join(temp.stateHome, "wux", "runs", name, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"send"');
      expect(events).toContain('"type":"handoff"');
      expect(events).toContain('"promptSource":"file"');
      expect(events).toContain('"waitMs":500');
      expect(events).toContain('"tail":50');
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("settles on the completion ladder before reading the pane", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("handoff-settle");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;

      // The completion summary only appears in the pane while the settle is in
      // flight. If `handoff` read before settling (the old fixed-sleep bug), the
      // marker would be absent. Proving it is present proves read-after-settle.
      const marker = "WUX-HANDOFF-COMPLETED-SUMMARY";
      const settle: (timeoutMs: number) => Promise<WaitResult> = async (timeoutMs) => {
        await sendCommand({ name, text: `printf '${marker}\\n'\n`, forceOwner: false });
        // Give the shell a beat to render the marker into the pane.
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          name,
          outcome: "done",
          completedVia: "quiescence",
          idleMs: 1_000,
          timeoutMs,
          waitedMs: 200,
          pollIntervalMs: 250,
        };
      };

      const output = await handoffRun({ name, waitMs: 5_000, tail: 100, wait: settle });
      expect(output).toContain(marker);

      const events = await readFile(join(temp.stateHome, "wux", "runs", name, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"handoff"');
      expect(events).toContain('"waitOutcome":"done"');
      expect(events).toContain('"settledVia":"quiescence"');
      expect(events).toContain('"waitedMs":200');
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("--wait-ms 0 reads immediately and records a skipped settle", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("handoff-nowait");
    let created = false;
    let settleInvoked = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;

      await handoffRun({
        name,
        waitMs: 0,
        tail: 50,
        wait: async (timeoutMs) => {
          settleInvoked = true;
          return stubWait()(timeoutMs);
        },
      });
      expect(settleInvoked).toBe(false);

      const events = await readFile(join(temp.stateHome, "wux", "runs", name, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"handoff"');
      expect(events).toContain('"waitMs":0');
      expect(events).toContain('"waitOutcome":"skipped"');
      expect(events).toContain('"settledVia":null');
      expect(events).toContain('"waitedMs":0');
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("uses defaults and records default prompt metadata", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("handoff-default");
    let created = false;
    const record: { timeoutMs?: number } = {};

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;

      await handoffRun({ name, wait: stubWait(record) });
      // Default `--wait-ms` is the upper bound the settle is given.
      expect(record.timeoutMs).toBe(DEFAULT_HANDOFF_WAIT_MS);

      const events = await readFile(join(temp.stateHome, "wux", "runs", name, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"handoff"');
      expect(events).toContain('"promptSource":"default"');
      expect(events).toContain(`"promptBytes":${Buffer.byteLength(DEFAULT_HANDOFF_PROMPT)}`);
      expect(events).toContain(`"waitMs":${DEFAULT_HANDOFF_WAIT_MS}`);
      expect(events).toContain(`"tail":${DEFAULT_HANDOFF_TAIL}`);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("validates timing and missing run arguments before sending", async () => {
    await expect(handoffRun({ name: "missing-handoff", waitMs: -1 })).rejects.toThrow("--wait-ms");
    await expect(handoffRun({ name: "missing-handoff", tail: 0 })).rejects.toThrow("--tail");
    await expect(handoffRun({ name: "", waitMs: 0 })).rejects.toThrow("handoff requires");
  });
});
