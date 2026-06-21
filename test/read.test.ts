import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { followRead, readRun } from "../src/commands/read";
import { runCommand } from "../src/commands/run";
import { sendCommand } from "../src/commands/send";
import { hasTmux, killTmux, tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("read", () => {
  test("captures live pane output without mutating events and respects tail", async () => {
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
