import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shellCommand } from "../src/backends/shell";
import { backendCommand } from "../src/backends";
import { runCommand } from "../src/commands/run";
import { runProcess } from "../src/runtime/process";
import { validateRunName } from "../src/runtime/runs";
import { runDir, runsRoot, stateRoot } from "../src/runtime/state";
import { hasSession } from "../src/runtime/tmux";
import { hasTmux, killTmux, tempState, waitForArgv } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("state paths", () => {
  test("resolves XDG state paths", () => {
    const env = { XDG_STATE_HOME: "/tmp/wux-state" } as NodeJS.ProcessEnv;
    expect(stateRoot(env)).toBe("/tmp/wux-state/wux");
    expect(runsRoot(env)).toBe("/tmp/wux-state/wux/runs");
    expect(runDir("smoke", env)).toBe("/tmp/wux-state/wux/runs/smoke");
  });

  test("validates conservative run names", () => {
    expect(() => validateRunName("valid.Name-1_2")).not.toThrow();
    expect(() => validateRunName("bad/name")).toThrow("invalid run name");
    expect(() => validateRunName(".")).toThrow("invalid run name");
    expect(() => validateRunName("..")).toThrow("invalid run name");
  });
});

describe("shell run lifecycle", () => {
  test("creates tmux session, metadata, pane log, and events", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("shell-life");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      expect(await hasSession(`wux_${name}`)).toBe(true);

      const dir = join(temp.stateHome, "wux", "runs", name);
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
      expect(meta.name).toBe(name);
      expect(meta.backend).toBe("shell");
      expect(meta.tmuxSession).toBe(`wux_${name}`);
      expect(meta.cwd).toBe(temp.root);
      expect(meta.status).toBe("running");
      expect(typeof meta.owner).toBe("string");

      const events = await readFile(join(dir, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"create"');
      await stat(join(dir, "pane.log"));

      await runProcess(["tmux", "send-keys", "-t", `wux_${name}`, "-l", "echo wux-pane-log"]);
      await runProcess(["tmux", "send-keys", "-t", `wux_${name}`, "Enter"]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await readFile(join(dir, "pane.log"), "utf8")).toContain("wux-pane-log");

      await expect(runCommand({ backend: "shell", name, cwd: temp.root })).rejects.toThrow("already exists");
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("appends backendArgs after the shell executable", async () => {
    expect(shellCommand({ SHELL: "/bin/zsh" })).toEqual(["/bin/zsh"]);
    expect(shellCommand({ SHELL: "/bin/zsh" }, ["-c", "echo hi"])).toEqual(["/bin/zsh", "-c", "echo hi"]);
    // Falls back to /bin/sh, passthrough still appended.
    expect(shellCommand({}, ["-l"])).toEqual(["/bin/sh", "-l"]);
    // backendCommand plumbs passthrough through unchanged.
    expect(await backendCommand("shell", { SHELL: "/bin/sh" }, {}, ["-x"])).toEqual(["/bin/sh", "-x"]);
  });

  test("persists shell backendArgs in run meta and passes them to the launched command", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeShell = join(bin, "fakesh");
    const argvLog = join(temp.root, "shell-argv.txt");
    const name = uniqueRunName("shell-passthrough");
    let created = false;

    try {
      await mkdir(bin);
      // A fake $SHELL that records the argv it actually receives through tmux,
      // one token per line. With a real /bin/sh the passthrough is consumed as
      // flags; the fake records them verbatim so a launch-path quoting/splitting
      // regression is caught (meta.command only proves what wux RECORDED).
      await writeFile(
        fakeShell,
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done\nsleep 30\n`,
        "utf8",
      );
      await chmod(fakeShell, 0o755);

      await runCommand({
        backend: "shell",
        name,
        cwd: temp.root,
        env: { SHELL: fakeShell },
        backendArgs: ["-x", "trailing arg with spaces"],
      });
      created = true;
      const dir = join(temp.stateHome, "wux", "runs", name);
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
      expect(meta.backendArgs).toEqual(["-x", "trailing arg with spaces"]);
      expect(meta.command).toEqual([fakeShell, "-x", "trailing arg with spaces"]);

      // Integration: the launched shell observed both passthrough tokens as
      // discrete argv entries through tmux — the spaced token stayed one token.
      const observedArgv = await waitForArgv(argvLog, 2);
      expect(observedArgv).toEqual(["-x", "trailing arg with spaces"]);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("uses exact tmux targets for session checks", async () => {
    if (!(await hasTmux())) return;
    const prefixSession = `wux_${uniqueRunName("prefix")}`;
    const existing = `${prefixSession}_long`;
    let created = false;
    try {
      const create = await runProcess(["tmux", "new-session", "-d", "-s", existing, "sh"]);
      expect(create.code).toBe(0);
      created = true;
      expect(await hasSession(prefixSession)).toBe(false);
      expect(await hasSession(existing)).toBe(true);
    } finally {
      if (created) await runProcess(["tmux", "kill-session", "-t", `=${existing}`]);
    }
  });

  test("concurrent duplicate run creation preserves the winning run state", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("dupe-race");
    let created = false;

    try {
      const results = await Promise.allSettled([
        runCommand({ backend: "shell", name, cwd: temp.root }),
        runCommand({ backend: "shell", name, cwd: temp.root }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      created = true;
      expect(await hasSession(`wux_${name}`)).toBe(true);
      await stat(join(temp.stateHome, "wux", "runs", name, "meta.json"));
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("does not kill a pre-existing tmux session with the same name", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("preexisting");
    let created = false;

    try {
      const create = await runProcess(["tmux", "new-session", "-d", "-s", `wux_${name}`, "sh"]);
      expect(create.code).toBe(0);
      created = true;
      await expect(runCommand({ backend: "shell", name, cwd: temp.root })).rejects.toThrow("tmux session already exists");
      expect(await hasSession(`wux_${name}`)).toBe(true);
      await expect(stat(join(temp.stateHome, "wux", "runs", name))).rejects.toThrow();
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("rejects missing cwd, cleans partial state, and rejects non-shell backends", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      const missingName = uniqueRunName("missing-cwd");
      await expect(runCommand({ backend: "shell", name: missingName, cwd: join(temp.root, "missing") })).rejects.toThrow("cwd does not exist");
      await expect(stat(join(temp.stateHome, "wux", "runs", missingName))).rejects.toThrow();
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("runProcess returns a failed result when a command cannot spawn", async () => {
    const result = await runProcess(["definitely-not-a-wux-command"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
