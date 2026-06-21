import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { interruptCommand } from "../src/commands/interrupt";
import { readCommand } from "../src/commands/read";
import { runCommand } from "../src/commands/run";
import { sendCommand } from "../src/commands/send";
import { statusCommand } from "../src/commands/status";
import { stopCommand } from "../src/commands/stop";
import { appendEvent, lastInput, readEvents } from "../src/runtime/events";
import { bufferIO } from "../src/runtime/io";
import { currentOwner } from "../src/runtime/owner";
import { hasTmux, killTmux, tempState } from "./helpers";

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

describe("bufferIO", () => {
  test("captures stdout and stderr in memory", () => {
    const buffer = bufferIO();
    buffer.io.stdout.write("hello ");
    buffer.io.stdout.write("world");
    buffer.io.stderr.write("oops");
    expect(buffer.stdout()).toBe("hello world");
    expect(buffer.stderr()).toBe("oops");
  });
});

describe("events lastInput reader", () => {
  test("derives lastInputAt/lastInputBy from the latest mutation event", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("events");
    try {
      expect(await lastInput(name)).toEqual({ lastInputAt: null, lastInputBy: null });

      await appendEvent(name, { type: "create", backend: "shell" }); // non-mutation
      await appendEvent(name, { type: "send", bytes: 3 }); // legacy mutation: no `by`
      const legacy = await lastInput(name);
      expect(legacy.lastInputBy).toBe(null); // null for events written before `by` existed
      expect(typeof legacy.lastInputAt).toBe("string");

      await appendEvent(name, { type: "interrupt", by: "alice@box" });
      expect((await lastInput(name)).lastInputBy).toBe("alice@box");

      // A later non-mutation event does not override the last mutation.
      await appendEvent(name, { type: "mark", status: "blocked" });
      expect((await lastInput(name)).lastInputBy).toBe("alice@box");

      expect((await readEvents(name)).length).toBe(4);
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});

describe("MCP-safe command composition", () => {
  test("send/interrupt/stop stamp by = owner; run/read/status/stop return typed results without touching process.stdout", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("io-results");
    const owner = currentOwner();
    let created = false;

    const writes: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };

    try {
      const run = await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      expect(run).toMatchObject({ name, backend: "shell", tmuxSession: `wux_${name}`, cwd: temp.root });
      expect(typeof run.runDir).toBe("string");

      const send = await sendCommand({ name, text: "echo io-ok", forceOwner: false });
      expect(send.name).toBe(name);
      expect((await lastInput(name)).lastInputBy).toBe(owner);

      const status = await statusCommand();
      expect(status.rows.some((row) => row.name === name)).toBe(true);

      const read = await readCommand({ name, tail: 50 });
      expect(read.name).toBe(name);
      expect(Array.isArray(read.lines)).toBe(true);
      expect(read.paneLogPath).toContain(name);

      const interrupted = await interruptCommand({ name, forceOwner: false });
      expect(interrupted).toEqual({ name, interrupted: true });
      expect((await lastInput(name)).lastInputBy).toBe(owner);

      const stop = await stopCommand(name, true);
      created = false;
      expect(stop).toEqual({ name, stopped: true });
      expect((await lastInput(name)).lastInputBy).toBe(owner);

      // The stop event also carries the owner actor.
      const events = await readFile(join(temp.stateHome, "wux", "runs", name, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"stop"');
      expect(events).toContain(`"by":"${owner}"`);

      // None of the command handlers wrote to the real process.stdout.
      expect(writes.join("")).toBe("");
    } finally {
      (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("CLI renders the same human output via the injected io sink", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("io-cli");
    let created = false;

    try {
      const create = memoryIO();
      expect(await runCli(["--local", "run", "shell", "--name", name, "--cwd", temp.root], create.io)).toBe(0);
      created = true;
      expect(create.output().stdout).toBe(`created ${name} (shell)\n`);

      const status = memoryIO();
      expect(await runCli(["--local", "status"], status.io)).toBe(0);
      expect(status.output().stdout).toContain("NAME");
      expect(status.output().stdout).toContain(name);

      // read renders the raw pane verbatim via readRun (no reconstruction): the CLI
      // output equals a direct readRun capture and is a raw scrape, not JSON.
      await sendCommand({ name, text: "echo CLI-READ-MARK", forceOwner: false });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const read = memoryIO();
      expect(await runCli(["--local", "read", name, "--tail", "200"], read.io)).toBe(0);
      expect(read.output().stdout).toContain("CLI-READ-MARK");
      expect(read.output().stdout.startsWith("{")).toBe(false);

      const stop = memoryIO();
      expect(await runCli(["--local", "stop", name, "--yes"], stop.io)).toBe(0);
      created = false;
      expect(stop.output().stdout).toBe(`stopped ${name}\n`);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("CLI renders run, status, and read json envelopes via the injected io sink", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("io-json");
    let created = false;

    try {
      const create = memoryIO();
      expect(await runCli(["--local", "run", "shell", "--name", name, "--cwd", temp.root, "--json"], create.io)).toBe(0);
      created = true;
      expect(JSON.parse(create.output().stdout)).toEqual({
        name,
        tmuxSession: `wux_${name}`,
        backend: "shell",
      });
      expect(create.output().stderr).toBe("");

      const status = memoryIO();
      expect(await runCli(["--local", "status", "--json"], status.io)).toBe(0);
      const rows = JSON.parse(status.output().stdout);
      expect(Array.isArray(rows)).toBe(true);
      const row = rows.find((item: { name?: string }) => item.name === name);
      expect(row).toMatchObject({
        name,
        backend: "shell",
        tmuxSession: `wux_${name}`,
        status: "running",
        cwd: temp.root,
        owner: expect.any(String),
        createdAt: expect.any(String),
        command: expect.any(Array),
      });

      await sendCommand({ name, text: "echo CLI-JSON-READ-MARK", forceOwner: false });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const read = memoryIO();
      expect(await runCli(["--local", "read", name, "--tail", "200", "--json"], read.io)).toBe(0);
      const body = JSON.parse(read.output().stdout);
      expect(body).toMatchObject({
        name,
        capturedAt: expect.any(String),
        paneLogPath: expect.stringContaining(name),
        runDir: expect.stringContaining(name),
      });
      expect(Array.isArray(body.lines)).toBe(true);
      expect(body.lines.join("\n")).toContain("CLI-JSON-READ-MARK");
      expect(body.turns).toBeUndefined();
      expect(body.messages).toBeUndefined();
      expect(body.assistant).toBeUndefined();
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});
