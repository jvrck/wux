import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { BUNDLED_SKILLS } from "../src/skills/embedded";
import { tempConfig } from "./helpers";

const repoRoot = join(import.meta.dir, "..");

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

async function run(args: string[]) {
  const memory = memoryIO();
  const code = await runCli(args, memory.io);
  return { code, ...memory.output() };
}

async function runCommand(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("skills command", () => {
  test("lists bundled skills as text and json", async () => {
    const result = await run(["skills", "list"]);

    expect(result).toEqual({
      code: 0,
      stdout: "wux\ndual-review\nwux-command\nwux-hub\n",
      stderr: "",
    });

    const json = await run(["skills", "list", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(["wux", "dual-review", "wux-command", "wux-hub"]);
  });

  test("shows bundled skill content verbatim", async () => {
    const expected = await readFile(join(repoRoot, ".claude", "skills", "wux", "SKILL.md"), "utf8");
    const result = await run(["skills", "show", "wux"]);

    expect(result).toEqual({ code: 0, stdout: expected, stderr: "" });
  });

  test("reports unknown skills without stdout", async () => {
    const result = await run(["skills", "show", "definitely-not-a-skill"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("wux: skill not found: definitely-not-a-skill\n");
  });

  test("strictly rejects unknown skills subcommands, options, and extra args", async () => {
    expect(await run(["skills", "bogus"])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "wux: unknown skills command: bogus\n",
    });
    expect(await run(["skills", "list", "extra"])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "wux: unexpected argument: extra\n",
    });
    expect(await run(["skills", "show", "wux", "extra"])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "wux: unexpected argument: extra\n",
    });
    expect(await run(["skills", "show", "--json"])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "wux: skills show requires <name>\n",
    });
  });

  test("show does not touch config or state directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "wux-skills-side-effects-"));
    const oldConfig = process.env.XDG_CONFIG_HOME;
    const oldState = process.env.XDG_STATE_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_STATE_HOME = join(root, "state");

    try {
      const result = await run(["skills", "show", "wux-hub"]);

      expect(result.code).toBe(0);
      expect(await exists(process.env.XDG_CONFIG_HOME)).toBe(false);
      expect(await exists(process.env.XDG_STATE_HOME)).toBe(false);
    } finally {
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldConfig;
      if (oldState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = oldState;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not default-forward with a configured default remote", async () => {
    const oldConfig = process.env.XDG_CONFIG_HOME;
    const temp = await tempConfig();
    process.env.XDG_CONFIG_HOME = temp.configHome;

    try {
      await run(["remotes", "add", "work", "worker", "--default"]);
      const memory = memoryIO();
      const calls: string[][] = [];
      const code = await runCli(["skills", "list"], memory.io, {
        sshRunner: async (args) => {
          calls.push(args);
          return { code: 0, stdout: "remote\n", stderr: "" };
        },
      });

      expect(code).toBe(0);
      expect(calls).toEqual([]);
      expect(memory.output().stdout).toBe("wux\ndual-review\nwux-command\nwux-hub\n");
    } finally {
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldConfig;
      await temp.cleanup();
    }
  });

  test("generated embedded assets match canonical Claude skill files", async () => {
    expect(BUNDLED_SKILLS.map((skill) => skill.name)).toEqual(["wux", "dual-review", "wux-command", "wux-hub"]);

    for (const skill of BUNDLED_SKILLS) {
      expect(skill.content).toBe(await readFile(join(repoRoot, skill.sourcePath), "utf8"));
    }
  });

  test(
    "compiled binary emits embedded skills from a temp cwd with no checkout",
    async () => {
      const build = await runCommand(["bun", "run", "build"], { cwd: repoRoot });
      if (build.code !== 0) {
        throw new Error(`build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
      }

      const temp = await mkdtemp(join(tmpdir(), "wux-skills-binary-"));
      try {
        const expected = await readFile(join(repoRoot, ".claude", "skills", "wux", "SKILL.md"), "utf8");
        const result = await runCommand([join(repoRoot, "dist", "wux"), "skills", "show", "wux"], { cwd: temp });

        expect(result).toEqual({ code: 0, stdout: expected, stderr: "" });
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
    30000,
  );
});

describe("install.sh skill placement", () => {
  test("documents opt-in skill installation via the emit verb", async () => {
    const script = await readFile(join(repoRoot, "install.sh"), "utf8");

    expect(script).toContain("--with-skills");
    expect(script).toContain("WUX_SKILLS_DIR");
    expect(script).toContain("DEFAULT_SKILLS=(wux wux-command wux-hub)");
    expect(script).toContain('"$BIN_DIR/wux" skills show "$skill" > "$path"');
    expect(script).toContain("installed skill: $path");
    expect(script).not.toContain("skills install");
  });
});
