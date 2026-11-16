import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { backendCommand } from "../src/backends";
import { codexCommand } from "../src/backends/codex";
import { runCommand } from "../src/commands/run";
import { sendCommand } from "../src/commands/send";
import { resultCommand } from "../src/commands/result";
import { waitCommand } from "../src/commands/wait";
import { appendEvent, inputMessageDigest, readEvents } from "../src/runtime/events";
import { runDir } from "../src/runtime/state";
import { runProcess } from "../src/runtime/process";
import { hasSession } from "../src/runtime/tmux";
import { hasTmux, killTmux, tempState, waitForArgv } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("codex backend", () => {
  test("resolves codex from PATH and records command metadata", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeCodex = join(bin, "codex");
    const name = uniqueRunName("codex-fake");
    let created = false;

    try {
      await mkdir(bin);
      await writeFile(fakeCodex, "#!/bin/sh\nprintf 'fake codex ready\\n'\nsleep 30\n", "utf8");
      await chmod(fakeCodex, 0o755);

      expect(await codexCommand({ PATH: bin })).toEqual([fakeCodex]);
      expect(await codexCommand({ PATH: bin }, { notifyCommand: ["/tmp/wux-notify", name] })).toEqual([
        fakeCodex,
        "-c",
        `notify=${JSON.stringify(["/tmp/wux-notify", name])}`,
      ]);
      expect(await backendCommand("codex", { PATH: bin })).toEqual([fakeCodex]);

      await runCommand({
        backend: "codex",
        name,
        cwd: temp.root,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WUX_NOTIFY_PATH: "/tmp/wux-notify" },
      });
      created = true;
      expect(await hasSession(`wux_${name}`)).toBe(true);

      const meta = JSON.parse(await readFile(join(temp.stateHome, "wux", "runs", name, "meta.json"), "utf8"));
      expect(meta.backend).toBe("codex");
      expect(meta.command).toEqual([fakeCodex, "-c", `notify=${JSON.stringify(["/tmp/wux-notify", name])}`]);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("appends backendArgs after wux-managed args and preserves the notify hook", async () => {
    const temp = await tempState();
    const bin = join(temp.root, "bin");
    const fakeCodex = join(bin, "codex");
    try {
      await mkdir(bin);
      await writeFile(fakeCodex, "#!/bin/sh\n", "utf8");
      await chmod(fakeCodex, 0o755);

      // No hook: passthrough follows the bare executable.
      expect(await codexCommand({ PATH: bin }, {}, ["--full-auto"])).toEqual([fakeCodex, "--full-auto"]);

      // With hook: passthrough follows -c notify, hook intact and not clobbered.
      expect(
        await codexCommand({ PATH: bin }, { notifyCommand: ["/tmp/wux-notify", "y"] }, ["--full-auto", "--sandbox", "workspace-write"]),
      ).toEqual([fakeCodex, "-c", `notify=${JSON.stringify(["/tmp/wux-notify", "y"])}`, "--full-auto", "--sandbox", "workspace-write"]);

      // backendCommand plumbs passthrough through unchanged.
      expect(await backendCommand("codex", { PATH: bin }, {}, ["-a", "never"])).toEqual([fakeCodex, "-a", "never"]);

      // No `--` (empty backendArgs) is byte-identical to the pre-passthrough path.
      expect(await codexCommand({ PATH: bin })).toEqual([fakeCodex]);
    } finally {
      await temp.cleanup();
    }
  });

  test("persists backendArgs in run meta and passes them to the launched command", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeCodex = join(bin, "codex");
    const argvLog = join(temp.root, "codex-argv.txt");
    const name = uniqueRunName("codex-passthrough");
    let created = false;

    try {
      await mkdir(bin);
      // Record the argv the launched process actually receives through tmux, one
      // token per line, so a launch-path quoting/splitting regression is caught
      // (meta.command only proves what wux RECORDED, not what tmux DELIVERED).
      await writeFile(
        fakeCodex,
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done\nprintf 'fake codex ready\\n'\nsleep 30\n`,
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      await runCommand({
        backend: "codex",
        name,
        cwd: temp.root,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WUX_NOTIFY_PATH: "/tmp/wux-notify" },
        backendArgs: ["--full-auto"],
      });
      created = true;

      const meta = JSON.parse(await readFile(join(temp.stateHome, "wux", "runs", name, "meta.json"), "utf8"));
      expect(meta.backendArgs).toEqual(["--full-auto"]);
      expect(meta.command).toEqual([
        fakeCodex,
        "-c",
        `notify=${JSON.stringify(["/tmp/wux-notify", name])}`,
        "--full-auto",
      ]);

      // Integration: the live process actually observed the wux-managed notify
      // arg AND the forwarded passthrough as discrete argv tokens through tmux.
      const observedArgv = await waitForArgv(argvLog, 3);
      expect(observedArgv).toEqual(["-c", `notify=${JSON.stringify(["/tmp/wux-notify", name])}`, "--full-auto"]);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("a fake Codex title hook leaves a real run unsettled until its matching completion", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeCodex = join(bin, "codex");
    const notifyWrapper = join(bin, "wux-notify");
    const gate = join(temp.root, "emit-title");
    const titleSent = join(temp.root, "title-sent");
    const notifyPath = join(process.cwd(), "src", "bin", "wux-notify.ts");
    const name = uniqueRunName("codex-title-probe");
    const prompt = "  Reply with WUX_REAL_REPLY \n";
    const normalizedPrompt = "Reply with WUX_REAL_REPLY";
    const title = JSON.stringify({ type: "agent-turn-complete", "turn-id": "title-turn", "input-messages": [`Generate a concise title for: ${normalizedPrompt}`], "last-assistant-message": '{"title":"Reply"}' });
    const real = JSON.stringify({ type: "agent-turn-complete", "turn-id": "real-turn", "input-messages": [normalizedPrompt], "last-assistant-message": "WUX_REAL_REPLY" });
    let created = false;

    try {
      await mkdir(bin);
      await writeFile(
        notifyWrapper,
        `#!/bin/sh\nexport XDG_STATE_HOME=${JSON.stringify(temp.stateHome)}\nexec ${JSON.stringify(notifyPath)} "$@"\n`,
        "utf8",
      );
      await chmod(notifyWrapper, 0o755);
      await writeFile(
        fakeCodex,
        `#!/bin/sh\nwhile [ ! -e ${JSON.stringify(gate)} ]; do sleep 0.01; done\n${JSON.stringify(notifyWrapper)} ${JSON.stringify(name)} ${JSON.stringify(title)}\n: > ${JSON.stringify(titleSent)}\nsleep 30\n`,
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      await runCommand({
        backend: "codex",
        name,
        cwd: temp.root,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          WUX_NOTIFY_PATH: notifyWrapper,
        },
      });
      created = true;
      await appendEvent(name, { type: "send", inputMessageDigest: inputMessageDigest(prompt) });
      await writeFile(gate, "ready\n", "utf8");
      await waitForPath(titleSent);

      expect(await resultCommand({ name })).toMatchObject({ outcome: "unknown" });
      expect(await waitCommand({ name, idleMs: 10, timeoutMs: 40, pollIntervalMs: 10 })).toMatchObject({ outcome: "timeout" });
      const titleEvent = (await readEvents(name)).find((event) => event.type === "backend-signal" && event.turnId === "title-turn");
      expect(titleEvent).toMatchObject({ payloadType: "agent-turn-complete", inputMessagesCount: 1 });
      expect(titleEvent?.signal).toBeUndefined();

      expect((await runProcess([notifyWrapper, name, real], { env: { ...process.env, XDG_STATE_HOME: temp.stateHome } })).code).toBe(0);
      expect(await resultCommand({ name })).toMatchObject({ outcome: "done", completedVia: "hook", lastAssistantMessage: "WUX_REAL_REPLY" });
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("records the Codex turn before an immediate matching hook", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const oldStateHome = process.env.XDG_STATE_HOME;
    const oldReadiness = process.env.WUX_SEND_READINESS;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeCodex = join(bin, "codex");
    const hookSent = join(temp.root, "hook-sent");
    const notifyPath = join(process.cwd(), "src", "bin", "wux-notify.ts");
    const name = uniqueRunName("codex-immediate-hook");
    const prompt = "Reply with WUX_IMMEDIATE_REPLY";
    const eventsPath = join(temp.stateHome, "wux", "runs", name, "events.jsonl");
    const completion = JSON.stringify({ type: "backend-signal", signal: "turn-complete", at: "2026-06-08T00:00:01.000Z", run: name, turnId: "immediate-turn", lastAssistantMessage: "WUX_IMMEDIATE_REPLY", inputMessageDigest: inputMessageDigest(prompt) });
    let created = false;

    try {
      await mkdir(bin);
      await writeFile(
        fakeCodex,
        `#!/bin/sh\nstty raw -echo\ndd bs=1 count=1 of=/dev/null 2>/dev/null\nprintf '%s\\n' ${JSON.stringify(completion)} >> ${JSON.stringify(eventsPath)}\n: > ${JSON.stringify(hookSent)}\nsleep 30\n`,
        "utf8",
      );
      await chmod(fakeCodex, 0o755);
      await runCommand({ backend: "codex", name, cwd: temp.root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WUX_NOTIFY_PATH: notifyPath } });
      created = true;
      process.env.WUX_SEND_READINESS = "0";

      await sendCommand({ name, text: prompt, forceOwner: false });
      await waitForPath(hookSent);
      const events = await readEvents(name);
      const startedAt = events.findIndex((event) => event.type === "send" && event.phase === "started");
      const hookAt = events.findIndex((event) => event.type === "backend-signal" && event.turnId === "immediate-turn");
      expect(startedAt).toBeGreaterThanOrEqual(0);
      expect(startedAt).toBeLessThan(hookAt);
      expect(await resultCommand({ name })).toMatchObject({ outcome: "done", completedVia: "hook", lastAssistantMessage: "WUX_IMMEDIATE_REPLY" });
    } finally {
      if (created) await killTmux(name);
      if (oldReadiness === undefined) delete process.env.WUX_SEND_READINESS;
      else process.env.WUX_SEND_READINESS = oldReadiness;
      process.env.XDG_STATE_HOME = oldStateHome;
      await temp.cleanup();
    }
  });

  test("missing codex executable fails before creating run state", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const missingPath = join(temp.root, "empty-bin");
    const name = uniqueRunName("codex-missing");

    try {
      await mkdir(missingPath);
      await expect(codexCommand({ PATH: missingPath })).rejects.toThrow("codex executable not found");
      await expect(runCommand({ backend: "codex", name, cwd: temp.root, env: { PATH: missingPath } })).rejects.toThrow(
        "codex executable not found",
      );
      await expect(stat(runDir(name))).rejects.toThrow();
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});
