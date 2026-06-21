import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { configPath, loadConfig } from "../src/runtime/config";
import { hasTmux, tempConfig } from "./helpers";

// Standard non-interactive options injected before the `--` separator.
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];

// SSH_OPTS hard-codes ConnectTimeout=10, but sshRemoteArgs reads WUX_SSH_CONNECT_TIMEOUT
// (and the forward path reads WUX_SSH_TIMEOUT); clear them so an ambient override in a
// developer/CI environment cannot perturb the argv-shape assertions below.
const SSH_TIMEOUT_ENVS = ["WUX_SSH_CONNECT_TIMEOUT", "WUX_SSH_TIMEOUT"] as const;
const savedSshEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of SSH_TIMEOUT_ENVS) {
    savedSshEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of SSH_TIMEOUT_ENVS) {
    if (savedSshEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedSshEnv[key];
  }
});

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

async function withConfig<T>(fn: (configHome: string) => Promise<T>): Promise<T> {
  const temp = await tempConfig();
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = temp.configHome;
  try {
    return await fn(temp.configHome);
  } finally {
    process.env.XDG_CONFIG_HOME = old;
    await temp.cleanup();
  }
}

async function run(args: string[]) {
  const memory = memoryIO();
  const code = await runCli(args, memory.io);
  return { code, ...memory.output() };
}

describe("remotes config", () => {
  test("uses XDG config and returns an empty default config when missing", async () => {
    await withConfig(async (configHome) => {
      expect(configPath()).toBe(join(configHome, "wux", "config.json"));
      expect(await loadConfig()).toEqual({ version: 1, remotes: {} });
    });
  });

  test("reports invalid JSON as a Wux error", async () => {
    await withConfig(async (configHome) => {
      await mkdir(join(configHome, "wux"), { recursive: true });
      await writeFile(join(configHome, "wux", "config.json"), "{ nope", "utf8");

      await expect(loadConfig()).rejects.toThrow("invalid config JSON");
    });
  });
});

describe("remotes command", () => {
  test("adds, lists, shows, defaults, clears, and removes remotes", async () => {
    await withConfig(async () => {
      expect(await run(["remotes", "list"])).toMatchObject({ code: 0, stdout: "no remotes configured\n" });
      expect(JSON.parse((await run(["remotes", "list", "--json"])).stdout)).toEqual({ defaultRemote: null, remotes: [] });

      const add = await run(["remotes", "add", "work", "worker", "--wux-path", "/opt/wux", "--cwd", "/tmp", "--default"]);
      expect(add).toMatchObject({ code: 0, stderr: "" });
      expect(add.stdout).toContain("added remote work");
      expect(add.stdout).toContain("set default remote work");

      const raw = JSON.parse(await readFile(configPath(), "utf8"));
      expect(raw).toEqual({
        version: 1,
        defaultRemote: "work",
        remotes: { work: { host: "worker", wuxPath: "/opt/wux", defaultCwd: "/tmp" } },
      });

      const list = await run(["remotes", "list"]);
      expect(list.stdout).toContain("NAME");
      expect(list.stdout).toContain("work");
      expect(list.stdout).toContain("yes");
      expect(list.stdout).toContain("worker");
      expect(list.stdout).toContain("/opt/wux");
      expect(list.stdout).toContain("/tmp");

      const jsonList = await run(["remotes", "list", "--json"]);
      expect(JSON.parse(jsonList.stdout)).toEqual({
        defaultRemote: "work",
        remotes: [{ name: "work", host: "worker", wuxPath: "/opt/wux", defaultCwd: "/tmp", default: true }],
      });

      const show = await run(["remotes", "show", "work", "--json"]);
      expect(JSON.parse(show.stdout)).toEqual({ name: "work", host: "worker", wuxPath: "/opt/wux", defaultCwd: "/tmp", default: true });

      expect(await run(["remotes", "clear-default"])).toMatchObject({ code: 0, stdout: "cleared default remote\n" });
      expect((await loadConfig()).defaultRemote).toBeUndefined();

      expect(await run(["remotes", "default", "work"])).toMatchObject({ code: 0, stdout: "set default remote work\n" });
      expect((await loadConfig()).defaultRemote).toBe("work");

      expect(await run(["remotes", "remove", "work"])).toMatchObject({ code: 0, stdout: expect.stringContaining("removed remote work") });
      expect(await loadConfig()).toEqual({ version: 1, remotes: {} });
    });
  });

  test("validates remote input", async () => {
    await withConfig(async () => {
      expect(await run(["remotes", "add", "..", "worker"])).toMatchObject({
        code: 1,
        stderr: "wux: invalid remote name '..'; use letters, numbers, dot, underscore, or dash\n",
      });
      expect(await run(["remotes", "add", "work", "-oProxyCommand=bad"])).toMatchObject({
        code: 1,
        stderr: "wux: remotes add requires <ssh-host>\n",
      });
      await run(["remotes", "add", "work", "worker"]);
      expect(await run(["remotes", "add", "work", "worker2"])).toMatchObject({
        code: 1,
        stderr: "wux: remote already exists: work\n",
      });
      expect(await run(["remotes", "default", "missing"])).toMatchObject({
        code: 1,
        stderr: "wux: remote not found: missing\n",
      });
    });
  });

  test("doctor verifies remote tooling through SSH", async () => {
    await withConfig(async () => {
      await run(["remotes", "add", "work", "worker", "--wux-path", "/opt/wux", "--cwd", "/tmp"]);
      const memory = memoryIO();
      const calls: string[][] = [];

      const code = await runCli(["remotes", "doctor", "work"], memory.io, {
        sshRunner: async (args) => {
          calls.push(args);
          return { code: 0, stdout: "ok\n", stderr: "" };
        },
      });

      expect(code).toBe(0);
      expect(calls).toEqual([
        ["ssh", ...SSH_OPTS, "--", "worker", "'true'"],
        ["ssh", ...SSH_OPTS, "--", "worker", "'command' '-v' '/opt/wux'"],
        ["ssh", ...SSH_OPTS, "--", "worker", "'env' 'WUX_FORCE_LOCAL=1' '/opt/wux' '--version'"],
        ["ssh", ...SSH_OPTS, "--", "worker", "'tmux' '-V'"],
        ["ssh", ...SSH_OPTS, "--", "worker", "'command' '-v' 'claude'"],
        ["ssh", ...SSH_OPTS, "--", "worker", "'command' '-v' 'codex'"],
        ["ssh", ...SSH_OPTS, "--", "worker", "'test' '-d' '/tmp'"],
      ]);
      expect(memory.output().stdout).toContain("ssh: ok");
      expect(memory.output().stdout).toContain("wux: ok");
      expect(memory.output().stdout).toContain("tmux: ok");
      expect(memory.output().stdout).toContain("cwd: ok");
    });
  });

  test("doctor reports advisory claude/codex and a version-derived JSON report", async () => {
    await withConfig(async () => {
      await run(["remotes", "add", "work", "worker", "--wux-path", "/opt/wux"]);
      const memory = memoryIO();
      const code = await runCli(["remotes", "doctor", "work", "--json"], memory.io, {
        sshRunner: async (args) => {
          const cmd = args[args.length - 1];
          if (cmd.includes("'--version'")) return { code: 0, stdout: "2099.01.02\n", stderr: "" };
          if (cmd.includes("'tmux' '-V'")) return { code: 0, stdout: "tmux 3.4\n", stderr: "" };
          if (cmd.includes("'codex'")) return { code: 1, stdout: "", stderr: "not found" };
          return { code: 0, stdout: "ok\n", stderr: "" };
        },
      });

      expect(code).toBe(0);
      const report = JSON.parse(memory.output().stdout);
      expect(report.schemaVersion).toBe(1);
      expect(report.targetType).toBe("remote");
      expect(report.host).toBe("worker");
      expect(report.wuxVersion).toBe("2099.01.02");
      expect(report.skew).toBe(true); // remote version differs from local dev VERSION
      expect(Array.isArray(report.capabilities)).toBe(true);
      const labels = report.checks.map((check: { label: string }) => check.label);
      expect(labels).toContain("claude");
      expect(labels).toContain("codex");
      // codex absence is advisory: present in checks but does not block readiness
      const codex = report.checks.find((check: { label: string }) => check.label === "codex");
      expect(codex.ok).toBe(false);
      expect(report.ready).toBe(true);
      // Frozen §4: exact DoctorReport key set, and each DoctorCheck only carries label/ok/detail.
      expect(Object.keys(report).sort()).toEqual([
        "capabilities",
        "checks",
        "host",
        "ready",
        "schemaVersion",
        "skew",
        "targetType",
        "wuxPath",
        "wuxVersion",
      ]);
      expect(report.wuxPath).toBe("/opt/wux");
      for (const check of report.checks) {
        expect(typeof check.label).toBe("string");
        expect(typeof check.ok).toBe("boolean");
        expect(Object.keys(check).every((key: string) => key === "label" || key === "ok" || key === "detail")).toBe(true);
      }
    });
  });

  test("doctor reports every check and exits non-zero when a critical check fails", async () => {
    await withConfig(async () => {
      await run(["remotes", "add", "work", "worker"]);
      const memory = memoryIO();
      const seen: string[] = [];
      const code = await runCli(["remotes", "doctor", "work"], memory.io, {
        sshRunner: async (args) => {
          const cmd = args[args.length - 1];
          seen.push(cmd);
          if (cmd.includes("'tmux'")) return { code: 1, stdout: "", stderr: "tmux: command not found" };
          return { code: 0, stdout: "ok\n", stderr: "" };
        },
      });

      expect(code).toBe(1); // critical tmux failed
      // Not fail-fast: claude/codex checks still ran after the failed tmux check.
      expect(seen.some((cmd) => cmd.includes("'claude'"))).toBe(true);
      expect(seen.some((cmd) => cmd.includes("'codex'"))).toBe(true);
      expect(memory.output().stdout).toContain("tmux: FAILED");
      expect(memory.output().stdout).toContain("ready: no");
      expect(memory.output().stderr).toContain("not ready: work");
    });
  });

  test("doctor --all covers the local host first, then every remote (sorted)", async () => {
    if (!(await hasTmux())) return;
    await withConfig(async () => {
      await run(["remotes", "add", "bravo", "host-b"]);
      await run(["remotes", "add", "alpha", "host-a"]);
      const memory = memoryIO();
      const code = await runCli(["remotes", "doctor", "--all", "--json"], memory.io, {
        sshRunner: async () => ({ code: 0, stdout: "ok\n", stderr: "" }),
      });

      expect(code).toBe(0);
      const reports = JSON.parse(memory.output().stdout);
      expect(Array.isArray(reports)).toBe(true);
      expect(reports.length).toBe(3);
      expect(reports[0].targetType).toBe("local");
      expect(reports[0].host).toBe(null);
      expect(reports[1].host).toBe("host-a");
      expect(reports[2].host).toBe("host-b");
    });
  });

  test("doctor --all keeps reporting later remotes after one host fails, and exits non-zero", async () => {
    if (!(await hasTmux())) return;
    await withConfig(async () => {
      await run(["remotes", "add", "alpha", "host-a"]);
      await run(["remotes", "add", "bravo", "host-b"]);
      const memory = memoryIO();
      const code = await runCli(["remotes", "doctor", "--all", "--json"], memory.io, {
        sshRunner: async (args) => {
          const target = args[args.indexOf("--") + 1];
          // host-a is unreachable; its later checks fail but bravo must still be reported.
          if (target === "host-a") return { code: 255, stdout: "", stderr: "ssh: connect refused" };
          return { code: 0, stdout: "ok\n", stderr: "" };
        },
      });

      expect(code).toBe(1); // host-a critical failure -> overall not ready
      const reports = JSON.parse(memory.output().stdout);
      expect(reports.map((r: { host: string | null }) => r.host)).toEqual([null, "host-a", "host-b"]);
      const alpha = reports.find((r: { host: string | null }) => r.host === "host-a");
      const bravo = reports.find((r: { host: string | null }) => r.host === "host-b");
      expect(alpha.ready).toBe(false);
      expect(bravo.ready).toBe(true); // a bad host never aborts the rest
      expect(memory.output().stderr).toContain("not ready: alpha");
    });
  });

  test("doctor requires <name> or --all", async () => {
    await withConfig(async () => {
      const result = await run(["remotes", "doctor"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("requires <name>");
    });
  });

  test("local and localhost are reserved remote names", async () => {
    await withConfig(async () => {
      const local = await run(["remotes", "add", "local", "host"]);
      expect(local.code).toBe(1);
      expect(local.stderr).toContain("reserved");
      const localhost = await run(["remotes", "add", "localhost", "host"]);
      expect(localhost.code).toBe(1);
      expect(localhost.stderr).toContain("reserved");
    });
  });

  test("explicit and default remotes forward operational commands", async () => {
    await withConfig(async () => {
      await run(["remotes", "add", "work", "worker", "--wux-path", "/opt/wux", "--default"]);
      const calls: string[][] = [];
      const memory = memoryIO();

      let code = await runCli(["status"], memory.io, {
        sshRunner: async (args) => {
          calls.push(args);
          return { code: 7, stdout: "remote status\n", stderr: "remote err\n" };
        },
      });

      expect(code).toBe(7);
      expect(calls).toEqual([["ssh", ...SSH_OPTS, "--", "worker", "'env' 'WUX_FORCE_LOCAL=1' '/opt/wux' 'status'"]]);
      expect(memory.output()).toEqual({ stdout: "remote status\n", stderr: "remote err\n" });

      calls.length = 0;
      code = await runCli(["--remote", "work", "read", "r", "--tail", "5"], memory.io, {
        sshRunner: async (args) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      expect(code).toBe(0);
      expect(calls).toEqual([["ssh", ...SSH_OPTS, "--", "worker", "'env' 'WUX_FORCE_LOCAL=1' '/opt/wux' 'read' 'r' '--tail' '5'"]]);
    });
  });

  test("root help, version, and local remotes management do not use default remotes", async () => {
    await withConfig(async () => {
      await run(["remotes", "add", "work", "worker", "--default"]);
      const calls: string[][] = [];
      for (const args of [["--help"], ["--version"], ["remotes", "list"]]) {
        const memory = memoryIO();
        const code = await runCli(args, memory.io, {
          sshRunner: async (sshArgs) => {
            calls.push(sshArgs);
            return { code: 0, stdout: "remote\n", stderr: "" };
          },
        });
        expect(code).toBe(0);
      }
      expect(calls).toEqual([]);
    });
  });

  test("raw --host resolves wux on the remote instead of forwarding a bare wux (#124)", async () => {
    await withConfig(async () => {
      const calls: string[][] = [];
      const memory = memoryIO();
      const code = await runCli(["--host", "raw-host", "status"], memory.io, {
        sshRunner: async (args) => {
          calls.push(args);
          return { code: 0, stdout: "remote status\n", stderr: "" };
        },
      });

      expect(code).toBe(0);
      expect(calls.length).toBe(1);
      const remote = calls[0][calls[0].length - 1];
      // The named-remote shape ('env' WUX_FORCE_LOCAL=1 wux ...) must NOT be used for
      // a raw host; instead an sh -c resolver wraps the wux command.
      expect(remote.startsWith("'sh' '-c' ")).toBe(true);
      expect(remote).not.toContain("'env' 'WUX_FORCE_LOCAL=1' 'wux' 'status'");
      expect(remote).toContain('"$HOME/.local/bin/wux"');
      expect(remote.endsWith("'wux' 'raw-host' '' 'status'")).toBe(true);
    });
  });

  test("raw --host --host-wux forwards the explicit hint as the resolver's first choice (#124)", async () => {
    await withConfig(async () => {
      const calls: string[][] = [];
      const memory = memoryIO();
      const code = await runCli(["--host", "raw-host", "--host-wux", "/opt/wux/bin/wux", "status"], memory.io, {
        sshRunner: async (args) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      });

      expect(code).toBe(0);
      const remote = calls[0][calls[0].length - 1];
      expect(remote.endsWith("'wux' 'raw-host' '/opt/wux/bin/wux' 'status'")).toBe(true);
    });
  });

  test("raw --host honors WUX_REMOTE_WUX_PATH when --host-wux is absent (#124)", async () => {
    await withConfig(async () => {
      const saved = process.env.WUX_REMOTE_WUX_PATH;
      process.env.WUX_REMOTE_WUX_PATH = "/env/path/wux";
      try {
        const calls: string[][] = [];
        const memory = memoryIO();
        const code = await runCli(["--host", "raw-host", "status"], memory.io, {
          sshRunner: async (args) => {
            calls.push(args);
            return { code: 0, stdout: "", stderr: "" };
          },
        });
        expect(code).toBe(0);
        expect(calls[0][calls[0].length - 1].endsWith("'wux' 'raw-host' '/env/path/wux' 'status'")).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.WUX_REMOTE_WUX_PATH;
        else process.env.WUX_REMOTE_WUX_PATH = saved;
      }
    });
  });

  test("--host-wux explicit value beats the WUX_REMOTE_WUX_PATH env hint (#124)", async () => {
    await withConfig(async () => {
      const saved = process.env.WUX_REMOTE_WUX_PATH;
      process.env.WUX_REMOTE_WUX_PATH = "/env/path/wux";
      try {
        const calls: string[][] = [];
        const code = await runCli(["--host", "raw-host", "--host-wux", "/flag/wux", "status"], memoryIO().io, {
          sshRunner: async (args) => {
            calls.push(args);
            return { code: 0, stdout: "", stderr: "" };
          },
        });
        expect(code).toBe(0);
        expect(calls[0][calls[0].length - 1].endsWith("'wux' 'raw-host' '/flag/wux' 'status'")).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.WUX_REMOTE_WUX_PATH;
        else process.env.WUX_REMOTE_WUX_PATH = saved;
      }
    });
  });

  test("a genuine remote miss surfaces the resolver's actionable error, not env: 'wux' (#124)", async () => {
    await withConfig(async () => {
      const memory = memoryIO();
      const notFound =
        "wux: could not resolve a wux binary on host 'raw-host' (tried --host-wux hint, ~/.local/bin/wux, " +
        "login-shell PATH, and bare wux on the non-interactive PATH). Install wux there (see docs/running.md) " +
        "or pass --host-wux <path> / set WUX_REMOTE_WUX_PATH=<path>.\n";
      const code = await runCli(["--host", "raw-host", "status"], memory.io, {
        // Simulate the remote resolver returning 127 with its actionable stderr.
        sshRunner: async () => ({ code: 127, stdout: "", stderr: notFound }),
      });

      expect(code).toBe(127);
      // The error is passed through verbatim with no local decoration.
      expect(memory.output().stderr).toBe(notFound);
      expect(memory.output().stderr).not.toContain("env: 'wux'");
    });
  });

  test("--host-wux requires --host and rejects a missing value (#124)", async () => {
    await withConfig(async () => {
      expect(await run(["--host-wux", "/opt/wux", "status"])).toMatchObject({
        code: 1,
        stderr: "wux: --host-wux requires --host <host>\n",
      });
      expect(await run(["--remote", "work", "--host-wux", "/opt/wux", "status"])).toMatchObject({
        code: 1,
        stderr: "wux: --host-wux requires --host <host>\n",
      });
      expect(await run(["--host", "raw-host", "--host-wux"])).toMatchObject({
        code: 1,
        stderr: "wux: --host-wux requires <path>\n",
      });
    });
  });

  test("force-local environment bypasses a configured default remote", async () => {
    await withConfig(async (configHome) => {
      await run(["remotes", "add", "work", "worker", "--default"]);
      const oldForceLocal = process.env.WUX_FORCE_LOCAL;
      const oldState = process.env.XDG_STATE_HOME;
      process.env.WUX_FORCE_LOCAL = "1";
      process.env.XDG_STATE_HOME = configHome;
      const calls: string[][] = [];

      try {
        const code = await runCli(["status"], memoryIO().io, {
          sshRunner: async (sshArgs) => {
            calls.push(sshArgs);
            return { code: 0, stdout: "remote\n", stderr: "" };
          },
        });

        expect(code).toBe(0);
        expect(calls).toEqual([]);
      } finally {
        if (oldForceLocal === undefined) {
          delete process.env.WUX_FORCE_LOCAL;
        } else {
          process.env.WUX_FORCE_LOCAL = oldForceLocal;
        }
        if (oldState === undefined) {
          delete process.env.XDG_STATE_HOME;
        } else {
          process.env.XDG_STATE_HOME = oldState;
        }
      }
    });
  });
});
