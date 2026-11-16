import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { claudeCommand } from "../src/backends/claude";
import { backendCommand } from "../src/backends";
import { resolveExecutable } from "../src/backends/path";
import { runCommand } from "../src/commands/run";
import { runProcess } from "../src/runtime/process";
import { runDir } from "../src/runtime/state";
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

describe("claude backend", () => {
  test("resolves claude from PATH and records command metadata", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeClaude = join(bin, "claude");
    const name = uniqueRunName("claude-fake");
    let created = false;

    try {
      await mkdir(bin);
      await writeFile(fakeClaude, "#!/bin/sh\nprintf 'fake claude ready\\n'\nsleep 30\n", "utf8");
      await chmod(fakeClaude, 0o755);

      expect(await claudeCommand({ PATH: bin })).toEqual([fakeClaude]);
      const hooked = await claudeCommand({ PATH: bin }, { notifyCommand: ["/tmp/wux-notify", name] });
      expect(hooked[0]).toBe(fakeClaude);
      expect(hooked[1]).toBe("--settings");
      const settings = JSON.parse(hooked[2]);
      expect(settings.hooks.Stop[0].hooks[0]).toEqual({
        type: "command",
        command: `'/tmp/wux-notify' '${name}'`,
      });
      expect(await backendCommand("claude", { PATH: bin })).toEqual([fakeClaude]);

      await runCommand({
        backend: "claude",
        name,
        cwd: temp.root,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WUX_NOTIFY_PATH: "/tmp/wux-notify" },
      });
      created = true;
      expect(await hasSession(`wux_${name}`)).toBe(true);

      const meta = JSON.parse(await readFile(join(temp.stateHome, "wux", "runs", name, "meta.json"), "utf8"));
      expect(meta.backend).toBe("claude");
      expect(meta.command[0]).toBe(fakeClaude);
      expect(meta.command).toContain("--settings");
      expect(JSON.stringify(JSON.parse(meta.command[2]))).toContain("/tmp/wux-notify");
      expect(JSON.stringify(JSON.parse(meta.command[2]))).toContain(name);
      const remainOnExit = await runProcess(["tmux", "show-options", "-t", `=wux_${name}:`, "-v", "remain-on-exit"]);
      expect(remainOnExit.code).toBe(0);
      expect(remainOnExit.stdout.trim()).toBe("off");
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("fails loudly when an interactive claude exits during startup", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeClaude = join(bin, "claude");
    const name = uniqueRunName("claude-startup-exit");

    try {
      await mkdir(bin);
      await writeFile(fakeClaude, "#!/bin/sh\nprintf '\\033[31mstartup dialog evidence\\033[0m\\007\\n'\nexit 7\n", "utf8");
      await chmod(fakeClaude, 0o755);

      await expect(
        runCommand({
          backend: "claude",
          name,
          cwd: temp.root,
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WUX_NOTIFY_PATH: "/tmp/wux-notify" },
        }),
      ).rejects.toThrow(/exited-during-startup.*startup dialog evidence/s);
      const events = await readFile(join(runDir(name), "events.jsonl"), "utf8");
      expect(events).toContain('"result":"exited-during-startup"');
      expect(events).toContain('"exitStatus":"7"');
      expect(events).toContain("startup dialog evidence");
      expect(events).not.toContain("\x1b");
      expect(events).not.toContain("\x07");
      expect(await hasSession(`wux_${name}`)).toBe(false);
    } finally {
      await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("reports a tmux transport loss during startup without fabricating an exit", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const socketRoot = join(temp.root, "tmux");
    const fakeClaude = join(bin, "claude");
    const name = uniqueRunName("claude-startup-unavailable");
    let socketParent: string | undefined;
    let socketPath: string | undefined;
    let socketMode: number | undefined;

    try {
      await mkdir(bin);
      await mkdir(socketRoot);
      await writeFile(fakeClaude, "#!/bin/sh\nprintf 'still running\\n'\nsleep 30\n", "utf8");
      await chmod(fakeClaude, 0o755);

      const result = runCommand({
        backend: "claude",
        name,
        cwd: temp.root,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          TMUX_TMPDIR: socketRoot,
          WUX_NOTIFY_PATH: "/tmp/wux-notify",
        },
      });
      await waitForPath(join(runDir(name), "startup-ready"));
      const socketDir = (await readdir(socketRoot, { withFileTypes: true })).find((entry) => entry.isDirectory());
      if (!socketDir) throw new Error("tmux socket directory was not created");
      socketParent = join(socketRoot, socketDir.name);
      socketPath = join(socketParent, "default");
      socketMode = (await stat(socketParent)).mode & 0o777;
      await chmod(socketParent, 0);

      await expect(result).rejects.toThrow(/tmux server is unavailable/);
      await chmod(socketParent, socketMode);
      socketMode = undefined;
      const events = await readFile(join(runDir(name), "events.jsonl"), "utf8");
      expect(events).not.toContain("exited-during-startup");
      const meta = JSON.parse(await readFile(join(runDir(name), "meta.json"), "utf8"));
      expect(meta.status).toBe("running");
      expect((await runProcess(["tmux", "-S", socketPath, "has-session", "-t", `=wux_${name}`])).code).toBe(0);
    } finally {
      if (socketParent && socketMode !== undefined) await chmod(socketParent, socketMode);
      if (socketPath) await runProcess(["tmux", "-S", socketPath, "kill-session", "-t", `=wux_${name}`]);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("leaves claude --print unchanged when it exits during startup", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeClaude = join(bin, "claude");
    const name = uniqueRunName("claude-print");

    try {
      await mkdir(bin);
      await writeFile(fakeClaude, "#!/bin/sh\nprintf 'print completed\\n'\nsleep 0.2\nexit 0\n", "utf8");
      await chmod(fakeClaude, 0o755);

      await expect(
        runCommand({
          backend: "claude",
          name,
          cwd: temp.root,
          backendArgs: ["--print"],
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WUX_NOTIFY_PATH: "/tmp/wux-notify" },
        }),
      ).resolves.toMatchObject({ name, backend: "claude" });
    } finally {
      await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("leaves claude -p unchanged when it exits during startup", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeClaude = join(bin, "claude");
    const name = uniqueRunName("claude-print-short");

    try {
      await mkdir(bin);
      await writeFile(fakeClaude, "#!/bin/sh\nprintf 'print completed\\n'\nsleep 0.2\nexit 0\n", "utf8");
      await chmod(fakeClaude, 0o755);

      await expect(
        runCommand({
          backend: "claude",
          name,
          cwd: temp.root,
          backendArgs: ["-p"],
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WUX_NOTIFY_PATH: "/tmp/wux-notify" },
        }),
      ).resolves.toMatchObject({ name, backend: "claude" });
    } finally {
      await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("does not treat backend input after -- as claude print mode", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeClaude = join(bin, "claude");
    const name = uniqueRunName("claude-passthrough-print");

    try {
      await mkdir(bin);
      await writeFile(fakeClaude, "#!/bin/sh\nprintf 'interactive startup exit\\n'\nexit 0\n", "utf8");
      await chmod(fakeClaude, 0o755);

      await expect(
        runCommand({
          backend: "claude",
          name,
          cwd: temp.root,
          backendArgs: ["--", "-p"],
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WUX_NOTIFY_PATH: "/tmp/wux-notify" },
        }),
      ).rejects.toThrow(/exited-during-startup/);
    } finally {
      await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("appends backendArgs after wux-managed args and preserves the notify hook", async () => {
    const temp = await tempState();
    const bin = join(temp.root, "bin");
    const fakeClaude = join(bin, "claude");
    try {
      await mkdir(bin);
      await writeFile(fakeClaude, "#!/bin/sh\n", "utf8");
      await chmod(fakeClaude, 0o755);

      // No hook: passthrough follows the bare executable.
      expect(await claudeCommand({ PATH: bin }, {}, ["--dangerously-skip-permissions"])).toEqual([
        fakeClaude,
        "--dangerously-skip-permissions",
      ]);

      // With hook: passthrough follows --settings, hook intact and not clobbered.
      const hooked = await claudeCommand({ PATH: bin }, { notifyCommand: ["/tmp/wux-notify", "x"] }, [
        "--dangerously-skip-permissions",
        "--model",
        "opus",
      ]);
      expect(hooked.slice(0, 3)).toEqual([
        fakeClaude,
        "--settings",
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: "command", command: `'/tmp/wux-notify' 'x'` }] }] },
        }),
      ]);
      expect(hooked.slice(3)).toEqual(["--dangerously-skip-permissions", "--model", "opus"]);

      // backendCommand plumbs passthrough through unchanged.
      expect(await backendCommand("claude", { PATH: bin }, {}, ["--add-dir", "/p"])).toEqual([fakeClaude, "--add-dir", "/p"]);

      // No `--` (empty backendArgs) is byte-identical to the pre-passthrough path.
      expect(await claudeCommand({ PATH: bin })).toEqual([fakeClaude]);
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
    const fakeClaude = join(bin, "claude");
    const argvLog = join(temp.root, "claude-argv.txt");
    const name = uniqueRunName("claude-passthrough");
    let created = false;

    try {
      await mkdir(bin);
      // Record the argv the launched process actually receives through tmux, one
      // token per line, so a launch-path quoting/splitting regression is caught
      // (meta.command only proves what wux RECORDED, not what tmux DELIVERED).
      await writeFile(
        fakeClaude,
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done\nprintf 'fake claude ready\\n'\nsleep 30\n`,
        "utf8",
      );
      await chmod(fakeClaude, 0o755);

      await runCommand({
        backend: "claude",
        name,
        cwd: temp.root,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WUX_NOTIFY_PATH: "/tmp/wux-notify" },
        backendArgs: ["--dangerously-skip-permissions"],
      });
      created = true;

      const meta = JSON.parse(await readFile(join(temp.stateHome, "wux", "runs", name, "meta.json"), "utf8"));
      expect(meta.backendArgs).toEqual(["--dangerously-skip-permissions"]);
      // Managed args (executable + --settings hook) first, passthrough last.
      expect(meta.command[0]).toBe(fakeClaude);
      expect(meta.command).toContain("--settings");
      expect(meta.command[meta.command.length - 1]).toBe("--dangerously-skip-permissions");

      // Integration: the live process actually observed the forwarded arg as a
      // discrete argv token (last line == the passthrough flag, byte-exact).
      const observedArgv = await waitForArgv(argvLog);
      expect(observedArgv).toContain("--dangerously-skip-permissions");
      expect(observedArgv[observedArgv.length - 1]).toBe("--dangerously-skip-permissions");
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("omits backendArgs from meta when no -- passthrough is given", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeClaude = join(bin, "claude");
    const name = uniqueRunName("claude-no-passthrough");
    let created = false;

    try {
      await mkdir(bin);
      await writeFile(fakeClaude, "#!/bin/sh\nprintf 'ready\\n'\nsleep 30\n", "utf8");
      await chmod(fakeClaude, 0o755);

      await runCommand({
        backend: "claude",
        name,
        cwd: temp.root,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, WUX_NOTIFY_PATH: "/tmp/wux-notify" },
      });
      created = true;

      const meta = JSON.parse(await readFile(join(temp.stateHome, "wux", "runs", name, "meta.json"), "utf8"));
      expect(meta).not.toHaveProperty("backendArgs");
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("missing claude executable fails before creating run state", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const missingPath = join(temp.root, "empty-bin");
    const name = uniqueRunName("claude-missing");

    try {
      await mkdir(missingPath);
      await expect(claudeCommand({ PATH: missingPath })).rejects.toThrow("claude executable not found");
      await expect(runCommand({ backend: "claude", name, cwd: temp.root, env: { PATH: missingPath } })).rejects.toThrow(
        "claude executable not found",
      );
      await expect(stat(runDir(name))).rejects.toThrow();
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("resolves relative and empty PATH entries to absolute executable paths", async () => {
    const temp = await tempState();
    const bin = join(temp.root, "bin");
    const relativeClaude = join(bin, "claude");
    const cwdClaude = join(temp.root, "claude");

    try {
      await mkdir(bin);
      await writeFile(relativeClaude, "#!/bin/sh\n", "utf8");
      await writeFile(cwdClaude, "#!/bin/sh\n", "utf8");
      await chmod(relativeClaude, 0o755);
      await chmod(cwdClaude, 0o755);
      expect(await resolveExecutable("claude", { PATH: `bin${delimiter}/missing` }, temp.root)).toBe(relativeClaude);
      expect(await resolveExecutable("claude", { PATH: `${delimiter}/missing` }, temp.root)).toBe(cwdClaude);
    } finally {
      await temp.cleanup();
    }
  });
});
