import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backendCommand } from "../src/backends";
import { codexCommand } from "../src/backends/codex";
import { runCommand } from "../src/commands/run";
import { runDir } from "../src/runtime/state";
import { hasSession } from "../src/runtime/tmux";
import { hasTmux, killTmux, tempState, waitForArgv } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

      await runCommand({ backend: "codex", name, cwd: temp.root, env: { PATH: bin, WUX_NOTIFY_PATH: "/tmp/wux-notify" } });
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
        env: { PATH: bin, WUX_NOTIFY_PATH: "/tmp/wux-notify" },
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
