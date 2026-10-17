import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { runNotifyCli } from "../src/bin/wux-notify";
import { readLatestBackendSignal } from "../src/runtime/events";
import { saveRun } from "../src/runtime/runs";
import { tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("wux-notify", () => {
  test("bare calls keep the legacy turn-complete signal for wired backends", async () => {
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
        expect(await readLatestBackendSignal(name)).toMatchObject({ signal: "turn-complete", turnId: `${backend}-turn` });
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

    try {
      const code = await runNotifyCli(
        [
          name,
          JSON.stringify({
            type: "agent-turn-complete",
            "turn-id": "codex-turn-1",
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
    let stdout = "";
    let stderr = "";

    try {
      const code = await runCli(
        [
          "notify",
          name,
          JSON.stringify({
            type: "TurnComplete",
            turn_id: "codex-turn-2",
            lastAssistantMessage: "cli final",
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

  test("maps approval payloads to awaiting-approval", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("notify-approval");

    try {
      const code = await runNotifyCli([name, JSON.stringify({ type: "permission-request" })], {
        stderr: { write: () => undefined },
      });

      expect(code).toBe(0);
      expect(await readLatestBackendSignal(name)).toMatchObject({
        type: "backend-signal",
        run: name,
        signal: "awaiting-approval",
      });
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
