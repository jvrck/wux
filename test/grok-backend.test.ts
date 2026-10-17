import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { backendCommand } from "../src/backends";
import { grokCommand } from "../src/backends/grok";
import { runCommand } from "../src/commands/run";
import { runDir } from "../src/runtime/state";
import { hasTmux, killTmux, tempState, waitForArgv } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("grok backend", () => {
  test("resolves grok from PATH and records passthrough after its managed command", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const bin = join(temp.root, "bin");
    const fakeGrok = join(bin, "grok");
    const argvLog = join(temp.root, "grok-argv.txt");
    const name = uniqueRunName("grok-fake");
    let created = false;

    try {
      await mkdir(bin);
      await writeFile(
        fakeGrok,
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done\nprintf 'fake grok ready\\n'\nsleep 30\n`,
        "utf8",
      );
      await chmod(fakeGrok, 0o755);

      expect(await grokCommand({ PATH: bin })).toEqual([fakeGrok]);
      expect(await backendCommand("grok", { PATH: bin }, { notifyCommand: ["/tmp/wux-notify", name] }, ["--no-auto-update"])).toEqual([
        fakeGrok,
        "--no-auto-update",
      ]);

      await runCommand({
        backend: "grok",
        name,
        cwd: temp.root,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
        backendArgs: ["--no-auto-update", "--model", "grok-4"],
      });
      created = true;

      const meta = JSON.parse(await readFile(join(temp.stateHome, "wux", "runs", name, "meta.json"), "utf8"));
      expect(meta.backend).toBe("grok");
      expect(meta.command).toEqual([fakeGrok, "--no-auto-update", "--model", "grok-4"]);
      expect(meta.backendArgs).toEqual(["--no-auto-update", "--model", "grok-4"]);
      expect(await waitForArgv(argvLog, 3)).toEqual(["--no-auto-update", "--model", "grok-4"]);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("missing grok fails before creating a run directory", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const missingPath = join(temp.root, "empty-bin");
    const name = uniqueRunName("grok-missing");
    try {
      await mkdir(missingPath);
      await expect(grokCommand({ PATH: missingPath })).rejects.toThrow("grok executable not found on PATH");
      await expect(runCommand({ backend: "grok", name, cwd: temp.root, env: { PATH: missingPath } })).rejects.toThrow(
        "grok executable not found on PATH",
      );
      await expect(stat(runDir(name))).rejects.toThrow();
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});
