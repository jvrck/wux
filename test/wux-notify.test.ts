import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { runNotifyCli } from "../src/bin/wux-notify";
import { appendEvent, inputMessageDigest, normalizeCodexInput, readEvents, readLatestBackendSignal } from "../src/runtime/events";
import { saveRun } from "../src/runtime/runs";
import { tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("wux-notify", () => {
  test("bare Claude calls stay explicit while bare Codex calls do not complete", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    try {
      for (const backend of ["claude", "codex"] as const) {
        const name = uniqueRunName(`notify-bare-${backend}`);
        await saveRun({ name, backend, tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
        const code = await runNotifyCli([name], {
          stdin: JSON.stringify({ type: "permission-request", turnId: `${backend}-turn` }),
          stderr: { write: () => undefined },
        });
        expect(code).toBe(0);
        if (backend === "claude") {
          expect(await readLatestBackendSignal(name)).toMatchObject({ signal: "turn-complete", turnId: `${backend}-turn` });
        } else {
          expect(await readLatestBackendSignal(name)).toBeUndefined();
          expect(await readEvents(name)).toContainEqual(expect.objectContaining({ type: "backend-signal", payloadType: "permission-request" }));
        }
      }
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("rejects Grok payloads without an explicit signal", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("notify-grok");
    const writes: string[] = [];
    try {
      await saveRun({ name, backend: "grok", tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
      for (const hookEventName of ["Notification", "PermissionDenied", "SubagentStop", "UnknownEvent"]) {
        const code = await runNotifyCli([name, JSON.stringify({ hookEventName })], { stderr: { write: (chunk: string) => writes.push(chunk) } });
        expect(code).toBe(1);
      }
      expect(await runNotifyCli([name], { stdin: JSON.stringify({ type: "permission-request" }), stderr: { write: (chunk: string) => writes.push(chunk) } })).toBe(1);
      expect(await readLatestBackendSignal(name)).toBeUndefined();
      expect(writes.join("")).toContain("explicit signal");
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("accepts explicit Grok completion and approval signals", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    try {
      for (const signal of ["turn-complete", "awaiting-approval"] as const) {
        const name = uniqueRunName(`notify-grok-${signal}`);
        await saveRun({ name, backend: "grok", tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
        expect(await runNotifyCli([name, signal], { stderr: { write: () => undefined } })).toBe(0);
        expect(await readLatestBackendSignal(name)).toMatchObject({ signal });
      }
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("writes a backend-signal event, turn-complete sentinel, and state file", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("notify");

    try {
      const code = await runNotifyCli([name, "turn-complete"], {
        stdin: JSON.stringify({ turnId: "turn-42", lastAssistantMessage: "final text" }),
        stderr: { write: () => undefined },
      });

      expect(code).toBe(0);
      expect(await readLatestBackendSignal(name)).toMatchObject({
        type: "backend-signal",
        run: name,
        signal: "turn-complete",
        turnId: "turn-42",
        lastAssistantMessage: "final text",
      });
      expect(await readFile(join(temp.stateHome, "wux", "runs", name, "turn-complete"), "utf8")).toContain("turn-complete");
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("accepts Codex-style event JSON as the second argument", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("notify-codex");
    const text = "codex final prompt";

    try {
      await saveRun({ name, backend: "codex", tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
      await appendEvent(name, { type: "send", inputMessageDigest: inputMessageDigest(text) });
      const code = await runNotifyCli(
        [
          name,
          JSON.stringify({
            type: "agent-turn-complete",
            "turn-id": "codex-turn-1",
            "input-messages": [text],
            "last-assistant-message": "codex final",
          }),
        ],
        { stderr: { write: () => undefined } },
      );

      expect(code).toBe(0);
      expect(await readLatestBackendSignal(name)).toMatchObject({
        type: "backend-signal",
        run: name,
        signal: "turn-complete",
        turnId: "codex-turn-1",
        lastAssistantMessage: "codex final",
        payloadType: "agent-turn-complete",
        inputMessageDigest: inputMessageDigest(text),
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("CLI notify dispatch accepts Codex-style event JSON", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("notify-cli-codex");
    const text = "cli final prompt";
    let stdout = "";
    let stderr = "";

    try {
      await saveRun({ name, backend: "codex", tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
      await appendEvent(name, { type: "send", inputMessageDigest: inputMessageDigest(text) });
      const code = await runCli(
        [
          "notify",
          name,
          JSON.stringify({
            type: "agent-turn-complete",
            "turn-id": "codex-turn-2",
            "input-messages": [text],
            "last-assistant-message": "cli final",
          }),
        ],
        {
          stdout: { write: (chunk: string) => (stdout += chunk) },
          stderr: { write: (chunk: string) => (stderr += chunk) },
        },
      );

      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(await readLatestBackendSignal(name)).toMatchObject({
        type: "backend-signal",
        run: name,
        signal: "turn-complete",
        turnId: "codex-turn-2",
        lastAssistantMessage: "cli final",
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("restores payload mapping for Claude and no-meta hooks", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      const stop = uniqueRunName("notify-claude-stop");
      const approval = uniqueRunName("notify-claude-approval");
      const noMeta = uniqueRunName("notify-no-meta");
      for (const name of [stop, approval]) {
        await saveRun({ name, backend: "claude", tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
      }
      expect(await runNotifyCli([stop, JSON.stringify({ hook_event_name: "Stop" })], { stderr: { write: () => undefined } })).toBe(0);
      expect(await runNotifyCli([approval, JSON.stringify({ type: "permission-request" })], { stderr: { write: () => undefined } })).toBe(0);
      expect(await runNotifyCli([noMeta, JSON.stringify({ hookEventName: "Stop" })], { stderr: { write: () => undefined } })).toBe(0);
      expect(await readLatestBackendSignal(stop)).toMatchObject({ signal: "turn-complete" });
      expect(await readLatestBackendSignal(approval)).toMatchObject({ signal: "awaiting-approval" });
      expect(await readLatestBackendSignal(noMeta)).toMatchObject({ signal: "turn-complete" });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("does not complete on a title payload before the matching real turn", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("notify-codex-title");
    const text = "Reply W4_REAL_REPLY";
    try {
      await saveRun({ name, backend: "codex", tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
      await appendEvent(name, { type: "send", inputMessageDigest: inputMessageDigest(text) });
      const title = {
        type: "agent-turn-complete",
        "turn-id": "title-turn",
        "input-messages": [`Generate a concise title.\n\nUser prompt:\n${text}`],
        "last-assistant-message": '{"title":"Reply"}',
      };
      const real = {
        type: "agent-turn-complete",
        "turn-id": "real-turn",
        "input-messages": ["prior turn", text],
        "last-assistant-message": "W4_REAL_REPLY",
      };

      expect(await runNotifyCli([name, JSON.stringify(title)], { stderr: { write: () => undefined } })).toBe(0);
      expect(await readLatestBackendSignal(name)).toBeUndefined();
      expect(await runNotifyCli([name, JSON.stringify(real)], { stderr: { write: () => undefined } })).toBe(0);
      expect(await readLatestBackendSignal(name)).toMatchObject({ signal: "turn-complete", turnId: "real-turn", lastAssistantMessage: "W4_REAL_REPLY" });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("matches Codex whitespace-normalized final input", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("notify-codex-trim");
    const padded = "  Reply W4_TRIM  \n";
    const normalized = "Reply W4_TRIM";
    try {
      await saveRun({ name, backend: "codex", tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
      await appendEvent(name, { type: "send", inputMessageDigest: inputMessageDigest(normalizeCodexInput(padded)) });
      expect(await runNotifyCli([name, JSON.stringify({ type: "agent-turn-complete", "input-messages": [normalized] })], { stderr: { write: () => undefined } })).toBe(0);
      expect(await readLatestBackendSignal(name)).toMatchObject({ signal: "turn-complete", inputMessageDigest: inputMessageDigest(normalized) });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("fails closed for an ambiguous late completion after identical sends", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("notify-codex-duplicate");
    const text = "continue";
    try {
      await saveRun({ name, backend: "codex", tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
      await appendEvent(name, { type: "send", inputMessageDigest: inputMessageDigest(text) });
      await runNotifyCli([name, JSON.stringify({ type: "agent-turn-complete", "input-messages": [`Generate title for ${text}`] })], { stderr: { write: () => undefined } });
      await appendEvent(name, { type: "send", inputMessageDigest: inputMessageDigest(text) });
      expect(await runNotifyCli([name, JSON.stringify({ type: "agent-turn-complete", "input-messages": [text] })], { stderr: { write: () => undefined } })).toBe(0);
      expect(await readLatestBackendSignal(name)).toBeUndefined();
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("accepts a normal turn after a missed Codex completion", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("notify-codex-missed");
    const missed = "missed turn";
    const text = "normal turn";
    try {
      await saveRun({ name, backend: "codex", tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
      await appendEvent(name, { type: "send", inputMessageDigest: inputMessageDigest(missed) });
      await appendEvent(name, { type: "send", inputMessageDigest: inputMessageDigest(text) });
      expect(await runNotifyCli([name, JSON.stringify({ type: "agent-turn-complete", "input-messages": [missed, text] })], { stderr: { write: () => undefined } })).toBe(0);
      expect(await readLatestBackendSignal(name)).toMatchObject({ signal: "turn-complete", inputMessagesCount: 2, inputMessageDigest: inputMessageDigest(text) });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("rejects explicit payloadless completion for Codex but retains it elsewhere", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const codex = uniqueRunName("notify-codex-explicit");
    const claude = uniqueRunName("notify-claude-explicit");
    const noMeta = uniqueRunName("notify-no-meta-explicit");
    try {
      for (const [name, backend] of [[codex, "codex"], [claude, "claude"]] as const) {
        await saveRun({ name, backend, tmuxSession: `wux_${name}`, cwd: "/tmp", owner: "tester@host", createdAt: new Date().toISOString(), status: "running" });
      }
      expect(await runNotifyCli([codex, "turn-complete"], { stderr: { write: () => undefined } })).toBe(0);
      expect(await runNotifyCli([claude, "turn-complete"], { stderr: { write: () => undefined } })).toBe(0);
      expect(await runNotifyCli([noMeta, "turn-complete"], { stderr: { write: () => undefined } })).toBe(0);
      expect(await readLatestBackendSignal(codex)).toBeUndefined();
      expect(await readLatestBackendSignal(claude)).toMatchObject({ signal: "turn-complete" });
      expect(await readLatestBackendSignal(noMeta)).toMatchObject({ signal: "turn-complete" });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("rejects invalid signals", async () => {
    const writes: string[] = [];
    const code = await runNotifyCli(["run-name", "done"], {
      stdin: "",
      stderr: { write: (chunk: string) => writes.push(chunk) },
    });

    expect(code).toBe(1);
    expect(writes.join("")).toContain("invalid signal");
  });
});
