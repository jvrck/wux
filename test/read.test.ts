import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { followRead, readLog, readRun } from "../src/commands/read";
import { runCommand } from "../src/commands/run";
import { sendCommand } from "../src/commands/send";
import { stopCommand } from "../src/commands/stop";
import { bufferIO } from "../src/runtime/io";
import { createRunMeta, saveRun } from "../src/runtime/runs";
import { hasTmux, killTmux, tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createLogRun(name: string, cwd: string, status: "running" | "stopped" = "running"): Promise<string> {
  const meta = await createRunMeta({ name, backend: "shell", cwd });
  await saveRun({ ...meta, status, ...(status === "stopped" ? { stoppedAt: meta.createdAt } : {}) });
  return join(process.env.XDG_STATE_HOME as string, "wux", "runs", name, "pane.log");
}

async function readLogBytes(name: string, tail?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await readLog({
    name,
    ...(tail === undefined ? {} : { tail }),
    writer: { write: (chunk) => chunks.push(Buffer.from(chunk)) },
  });
  return Buffer.concat(chunks);
}

async function readLogCliBytes(name: string, stateHome: string): Promise<Buffer> {
  const child = spawn(process.execPath, ["src/index.ts", "--local", "read", "--log", name], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, XDG_STATE_HOME: stateHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) throw new Error("expected piped child stdio");
  const chunks: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
  return Buffer.concat(chunks);
}

describe("read", () => {
  test("ordinary read remains a live tmux pane scrape", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-life");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      await sendCommand({ name, text: "printf 'wux-read-one\nwux-read-two\nwux-read-three\n'", forceOwner: false });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const dir = join(temp.stateHome, "wux", "runs", name);
      const eventsBefore = await readFile(join(dir, "events.jsonl"), "utf8");
      const output = await readRun({ name, tail: 20 });
      expect(output).toContain("wux-read-three");
      const tailed = await readRun({ name, tail: 3 });
      expect(tailed.trimEnd().split("\n").length).toBeLessThanOrEqual(3);
      const eventsAfter = await readFile(join(dir, "events.jsonl"), "utf8");
      expect(eventsAfter).toBe(eventsBefore);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("--log reads raw pane.log bytes from live and stopped runs", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-log-live-stopped");
    const bytes = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff, 0x0a]);
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const log = join(temp.stateHome, "wux", "runs", name, "pane.log");
      await writeFile(log, bytes);
      expect((await readLogCliBytes(name, temp.stateHome)).subarray(0, bytes.length)).toEqual(bytes);

      await stopCommand(name, true);
      created = false;
      expect(await readLogCliBytes(name, temp.stateHome)).toEqual(await readFile(log));
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("--log reads a stopped run without tmux byte-for-byte", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-log-stopped");
    const bytes = Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x6d, 0x0a]);

    try {
      const log = await createLogRun(name, temp.root, "stopped");
      await writeFile(log, bytes);
      expect(await readLogCliBytes(name, temp.stateHome)).toEqual(bytes);
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("--log --tail returns exactly the last five lines", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-log-tail");

    try {
      const log = await createLogRun(name, temp.root);
      await writeFile(log, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n", "utf8");
      expect((await readLogBytes(name, 5)).toString("utf8")).toBe("three\nfour\nfive\nsix\nseven\n");
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("--log --tail handles boundary cases and scans backward across chunks", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-log-tail-edges");

    try {
      const log = await createLogRun(name, temp.root);
      for (const { body, tail, expected } of [
        { body: "one\ntwo\nthree", tail: 2, expected: "two\nthree" },
        { body: "one\ntwo\n", tail: 5, expected: "one\ntwo\n" },
        { body: "", tail: 1, expected: "" },
        { body: "\n", tail: 1, expected: "\n" },
      ]) {
        await writeFile(log, body, "utf8");
        expect((await readLogBytes(name, tail)).toString("utf8")).toBe(expected);
      }

      const lines = Array.from({ length: 12_000 }, (_, index) => `line-${index}\n`);
      await writeFile(log, lines.join(""), "utf8");
      expect((await readLogBytes(name, 5)).toString("utf8")).toBe(lines.slice(-5).join(""));
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("--log gives retained chunks unique bytes and waits for drain before reading again", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-log-backpressure");
    const source = Buffer.allocUnsafe(256 * 1024 + 17);
    for (let index = 0; index < source.length; index += 1) source[index] = index % 251;
    source[0] = 0x00;
    source[64 * 1024 - 1] = 0xff;
    source[64 * 1024] = 0x00;

    try {
      const log = await createLogRun(name, temp.root);
      await writeFile(log, source);
      const retained: Uint8Array[] = [];
      let writesBeforeDrain = 0;
      await readLog({
        name,
        writer: {
          write: (chunk) => {
            retained.push(chunk);
            return retained.length === 1 ? false : true;
          },
          once: (_event, listener) => {
            setTimeout(() => {
              writesBeforeDrain = retained.length;
              listener();
            }, 10);
          },
        },
      });

      expect(writesBeforeDrain).toBe(1);
      expect(Buffer.concat(retained.map((chunk) => Buffer.from(chunk)))).toEqual(source);
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("--log reports a clear error when pane.log is missing", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-log-missing");

    try {
      await createLogRun(name, temp.root);
      await expect(readLogBytes(name)).rejects.toThrow(`no pane log for ${name}`);
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("--log rejects incompatible read modes", async () => {
    for (const args of [
      ["--local", "read", "--log", "--follow", "run"],
      ["--local", "read", "--log", "--json", "run"],
      ["--local", "read", "--log", "--poll-interval-ms", "10", "run"],
    ]) {
      const memory = bufferIO();
      expect(await runCli(args, memory.io)).toBe(1);
      expect(`${memory.stdout()}${memory.stderr()}`).toContain("--log cannot be combined");
    }
  });

  test("rejects invalid tail, missing runs, and absent sessions", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-dead");
    let created = false;

    try {
      await expect(readRun({ name: "missing-read", tail: 20 })).rejects.toThrow("run not found");
      await expect(readRun({ name: "missing-read", tail: 0 })).rejects.toThrow("tail");
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      await expect(readRun({ name, tail: 0 })).rejects.toThrow("tail");
      await killTmux(name);
      created = false;
      await expect(readRun({ name, tail: 20 })).rejects.toThrow("tmux session is not running");
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("follows appended pane.log bytes and stops when the session is gone", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-follow");
    const sentinel = `follow-sentinel-${name}`;
    const dir = join(temp.stateHome, "wux", "runs", name);
    const log = join(dir, "pane.log");
    let output = "";
    let sleeps = 0;

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(log, "old scrollback\n", "utf8");

      const result = await followRead({
        name,
        intervalMs: 10,
        writer: { write: (chunk) => (output += chunk) },
        loadRun: async () => ({ name, tmuxSession: `wux_${name}` }),
        hasSession: async () => sleeps < 2,
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 1) await appendFile(log, `${sentinel}\n`, "utf8");
        },
      });

      expect(result).toEqual({ name, interrupted: false });
      expect(output).toContain(sentinel);
      expect(output).not.toContain("old scrollback");
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("follow reports interruption when aborted", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-follow-abort");
    const dir = join(temp.stateHome, "wux", "runs", name);
    const log = join(dir, "pane.log");
    const abort = new AbortController();

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(log, "", "utf8");

      const result = await followRead({
        name,
        intervalMs: 10,
        writer: { write: () => undefined },
        signal: abort.signal,
        loadRun: async () => ({ name, tmuxSession: `wux_${name}` }),
        hasSession: async () => true,
        sleep: async () => abort.abort(),
      });

      expect(result).toEqual({ name, interrupted: true });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("CLI read --follow streams live pane.log and exits 130 on SIGINT", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("read-follow-cli");
    const sentinel = `S3-FOLLOW-SENTINEL-${name}`;
    let created = false;
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn> | undefined;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      child = spawn(process.execPath, ["src/index.ts", "--local", "read", "--follow", name, "--poll-interval-ms", "50"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, XDG_STATE_HOME: temp.stateHome },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.stdout || !child.stderr) throw new Error("expected piped child stdio");
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));

      for (let attempt = 0; attempt < 50 && !stdout.includes(sentinel); attempt += 1) {
        await sendCommand({ name, text: `printf '${sentinel}\\n'`, forceOwner: false });
        await delay(100);
      }
      expect(stdout).toContain(sentinel);

      child.kill("SIGINT");
      const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
      expect({ code, signal, stderr }).toEqual({ code: 130, signal: null, stderr: "" });
    } finally {
      if (child && !child.killed) child.kill("SIGTERM");
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});
