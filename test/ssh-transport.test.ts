import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import type { ProcessResult } from "../src/runtime/process";
import {
  connectTimeoutSeconds,
  forwardSshCommand,
  forwardTimeoutMs,
  remoteCommand,
  sshForwardArgs,
  sshRawHostForwardArgs,
  sshRemoteArgs,
  stripTargetArgs,
} from "../src/transport/ssh";

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

// Standard non-interactive options injected before the `--` separator.
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];

const TIMEOUT_ENVS = ["WUX_SSH_CONNECT_TIMEOUT", "WUX_SSH_TIMEOUT"] as const;

describe("ssh transport", () => {
  // Default argv-shape assertions hard-code ConnectTimeout=10, so a developer/CI
  // environment with these overrides set must not perturb them.
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of TIMEOUT_ENVS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of TIMEOUT_ENVS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test("builds structured ssh argv with a shell-quoted remote command", () => {
    expect(sshForwardArgs("worker", ["send", "run one", "hello spaces ! $PATH"])).toEqual([
      "ssh",
      ...SSH_OPTS,
      "--",
      "worker",
      "'env' 'WUX_FORCE_LOCAL=1' 'wux' 'send' 'run one' 'hello spaces ! $PATH'",
    ]);
    expect(sshForwardArgs("worker", ["status"], "/opt/wux/bin/wux")).toEqual([
      "ssh",
      ...SSH_OPTS,
      "--",
      "worker",
      "'env' 'WUX_FORCE_LOCAL=1' '/opt/wux/bin/wux' 'status'",
    ]);
  });

  test("injects non-interactive options into sshRemoteArgs", () => {
    const argv = sshRemoteArgs("worker", ["true"]);
    const separator = argv.indexOf("--");
    expect(separator).toBeGreaterThan(0);
    const options = argv.slice(0, separator);
    expect(options).toContain("BatchMode=yes");
    expect(options).toContain("ConnectTimeout=10");
    expect(options).toContain("StrictHostKeyChecking=accept-new");
    // Options sit before the separator, host and remote command after it.
    expect(argv.slice(separator)).toEqual(["--", "worker", "'true'"]);
  });

  test("injects non-interactive options into sshForwardArgs", () => {
    const argv = sshForwardArgs("worker", ["status"]);
    const separator = argv.indexOf("--");
    expect(separator).toBeGreaterThan(0);
    const options = argv.slice(0, separator);
    expect(options).toContain("BatchMode=yes");
    expect(options).toContain("ConnectTimeout=10");
    expect(options).toContain("StrictHostKeyChecking=accept-new");
  });

  test("WUX_SSH_CONNECT_TIMEOUT overrides the ConnectTimeout value", () => {
    expect(connectTimeoutSeconds()).toBe(10);
    process.env.WUX_SSH_CONNECT_TIMEOUT = "3";
    expect(sshRemoteArgs("worker", ["true"])).toContain("ConnectTimeout=3");
    // Non-numeric values fall back to the default.
    process.env.WUX_SSH_CONNECT_TIMEOUT = "not-a-number";
    expect(sshRemoteArgs("worker", ["true"])).toContain("ConnectTimeout=10");
    // Partial-numeric values (e.g. "5s") must NOT lenient-parse to 5.
    process.env.WUX_SSH_CONNECT_TIMEOUT = "5s";
    expect(sshRemoteArgs("worker", ["true"])).toContain("ConnectTimeout=10");
    // Zero / non-positive falls back.
    process.env.WUX_SSH_CONNECT_TIMEOUT = "0";
    expect(sshRemoteArgs("worker", ["true"])).toContain("ConnectTimeout=10");
  });

  test("WUX_SSH_TIMEOUT overrides the forward command timeout, with strict parsing", () => {
    expect(forwardTimeoutMs()).toBe(30000);
    process.env.WUX_SSH_TIMEOUT = "5000";
    expect(forwardTimeoutMs()).toBe(5000);
    // Partial-numeric ("30s") must fall back, not become 30 (which would time out almost immediately).
    process.env.WUX_SSH_TIMEOUT = "30s";
    expect(forwardTimeoutMs()).toBe(30000);
    // Unsafe-large integers fall back.
    process.env.WUX_SSH_TIMEOUT = "9999999999999999999";
    expect(forwardTimeoutMs()).toBe(30000);
    // A safe integer above the 32-bit timer max is capped (not clamped to ~1ms by setTimeout).
    process.env.WUX_SSH_TIMEOUT = "3000000000";
    expect(forwardTimeoutMs()).toBe(2_147_483_647);
  });

  test("forwarded attach is interactive: passes -tt and is not capped", async () => {
    const memory = memoryIO();
    let received: { args: string[] } | undefined;
    const code = await runCli(["--host", "worker", "attach", "r"], memory.io, {
      sshRunner: async (args) => {
        received = { args };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(0);
    // attach forwards through the interactive path: a remote PTY (-tt) wrapped in the
    // raw-host resolver snippet, run with inherited stdio (no command-timeout cap).
    expect(received?.args).toEqual(sshRawHostForwardArgs("worker", ["attach", "r"], "", { tty: true }));
  });

  test("sshRemoteArgs allocates a remote PTY (-tt) only when interactive", () => {
    const tty = sshRemoteArgs("worker", ["attach", "r"], { tty: true });
    expect(tty[0]).toBe("ssh");
    expect(tty[1]).toBe("-tt");
    // The PTY flag sits before the options/separator, like every other ssh option.
    expect(tty.indexOf("-tt")).toBeLessThan(tty.indexOf("--"));
    // Default / explicit-false carry no -tt (captured verbs must stay PTY-free).
    expect(sshRemoteArgs("worker", ["status"])).not.toContain("-tt");
    expect(sshRemoteArgs("worker", ["status"], { tty: false })).not.toContain("-tt");
  });

  test("the tty flag threads through both forward builders", () => {
    expect(sshForwardArgs("worker", ["attach", "r"], "wux", { tty: true })).toContain("-tt");
    expect(sshForwardArgs("worker", ["status"], "wux")).not.toContain("-tt");
    expect(sshRawHostForwardArgs("worker", ["attach", "r"], "", { tty: true })).toContain("-tt");
    expect(sshRawHostForwardArgs("worker", ["status"]).includes("-tt")).toBe(false);
  });

  test("interactive forward forces -tt, drops captured stdout, but surfaces stderr", async () => {
    const memory = memoryIO();
    const calls: string[][] = [];
    const code = await forwardSshCommand({
      host: "worker",
      args: ["attach", "r"],
      io: memory.io,
      resolveRemoteWux: true,
      interactive: true,
      timeoutMs: 0,
      runner: async (args) => {
        calls.push(args);
        // stdio:inherit yields no captured stdout in prod; stderr is only set on a
        // spawn-level failure (e.g. ssh missing) — that diagnostic must still surface.
        return { code: 7, stdout: "inherited-not-captured\n", stderr: "spawn boom\n" };
      },
    });
    expect(code).toBe(7);
    expect(calls[0]).toContain("-tt");
    // stdout (inherited) is never replayed (it would double-print the TUI); stderr (a
    // spawn-error diagnostic) IS written so a failed spawn isn't a silent exit code.
    expect(memory.output()).toEqual({ stdout: "", stderr: "spawn boom\n" });
  });

  test("interactive forwarding also applies to the named-remote (non-raw) path", async () => {
    const memory = memoryIO();
    const calls: string[][] = [];
    const code = await forwardSshCommand({
      host: "worker",
      args: ["attach", "r"],
      io: memory.io,
      wuxPath: "/opt/wux/bin/wux",
      interactive: true,
      timeoutMs: 0,
      runner: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(0);
    // Named-remote path uses sshForwardArgs (env WUX_FORCE_LOCAL), and still gets -tt.
    expect(calls[0]).toEqual(sshForwardArgs("worker", ["attach", "r"], "/opt/wux/bin/wux", { tty: true }));
  });

  test("attach --help is a help request, not interactive: forwarded captured, no -tt", async () => {
    const memory = memoryIO();
    const calls: string[][] = [];
    const code = await runCli(["--host", "worker", "attach", "--help"], memory.io, {
      sshRunner: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "ATTACH HELP\n", stderr: "" };
      },
    });
    expect(code).toBe(0);
    // No PTY, and the captured help text is relayed — not swallowed by inherited stdio.
    expect(calls[0]).not.toContain("-tt");
    expect(memory.output().stdout).toBe("ATTACH HELP\n");
  });

  test("long-blocking but captured verbs (wait, read --follow) are NOT interactive (no -tt)", async () => {
    const calls: string[][] = [];
    const sshRunner = async (args: string[]): Promise<ProcessResult> => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    await runCli(["--host", "worker", "wait", "r"], memoryIO().io, { sshRunner });
    await runCli(["--host", "worker", "read", "r", "--follow"], memoryIO().io, { sshRunner });
    expect(calls.length).toBe(2);
    expect(calls.every((args) => !args.includes("-tt"))).toBe(true);
  });

  test("quotes remote command arguments for the remote shell", () => {
    expect(remoteCommand(["wux", "send", "r", "--", "O'Brien; keep $PATH"])).toBe("'wux' 'send' 'r' '--' 'O'\\''Brien; keep $PATH'");
  });

  test("strips target selectors while preserving remaining arguments", () => {
    expect(stripTargetArgs(["--host", "worker", "status"])).toEqual(["status"]);
    expect(stripTargetArgs(["--host=worker", "send", "r", "--", "--literal"])).toEqual(["send", "r", "--", "--literal"]);
    expect(stripTargetArgs(["--remote", "work", "status"])).toEqual(["status"]);
    expect(stripTargetArgs(["--remote=work", "status"])).toEqual(["status"]);
    expect(stripTargetArgs(["--local", "status"])).toEqual(["status"]);
    expect(stripTargetArgs(["--help", "--host", "worker"])).toEqual(["--help"]);
    expect(stripTargetArgs(["--host", "worker", "send", "r", "--", "--host"])).toEqual(["send", "r", "--", "--host"]);
    expect(stripTargetArgs(["--remote", "work", "send", "r", "--", "--remote"])).toEqual(["send", "r", "--", "--remote"]);
    expect(stripTargetArgs(["--local", "send", "r", "--", "--local"])).toEqual(["send", "r", "--", "--local"]);
  });

  test("strips the --host-wux hint so it is never forwarded to the remote wux", () => {
    expect(stripTargetArgs(["--host", "worker", "--host-wux", "/opt/wux", "status"])).toEqual(["status"]);
    expect(stripTargetArgs(["--host", "worker", "--host-wux=/opt/wux", "status"])).toEqual(["status"]);
    // --host-wux must not be confused with --host=; a literal --host-wux after -- survives.
    expect(stripTargetArgs(["--host", "worker", "send", "r", "--", "--host-wux"])).toEqual(["send", "r", "--", "--host-wux"]);
  });

  test("passes remote stdout, stderr, and exit status through", async () => {
    const memory = memoryIO();
    const calls: string[][] = [];
    const code = await forwardSshCommand({
      host: "worker",
      args: ["status"],
      io: memory.io,
      runner: async (args): Promise<ProcessResult> => {
        calls.push(args);
        return { code: 42, stdout: "remote out\n", stderr: "remote err\n" };
      },
    });

    expect(code).toBe(42);
    expect(calls).toEqual([["ssh", ...SSH_OPTS, "--", "worker", "'env' 'WUX_FORCE_LOCAL=1' 'wux' 'status'"]]);
    expect(memory.output()).toEqual({ stdout: "remote out\n", stderr: "remote err\n" });
  });

  test("runCli forwards host commands and preserves quoted text arguments", async () => {
    const memory = memoryIO();
    const calls: string[][] = [];
    const code = await runCli(["--host", "worker", "send", "run-name", "hello world; keep $PATH", "--force-owner"], memory.io, {
      sshRunner: async (args) => {
        calls.push(args);
        return { code: 17, stdout: "", stderr: "ssh failed\n" };
      },
    });

    expect(code).toBe(17);
    // Raw --host forwards through the remote resolver snippet; the original wux
    // args (including the quoted literal text) ride as positionals after it.
    expect(calls).toEqual([sshRawHostForwardArgs("worker", ["send", "run-name", "hello world; keep $PATH", "--force-owner"])]);
    expect(memory.output()).toEqual({ stdout: "", stderr: "ssh failed\n" });
  });

  test("runCli forwards remote help instead of handling it locally", async () => {
    const memory = memoryIO();
    const calls: string[][] = [];
    const code = await runCli(["--host=worker", "--help"], memory.io, {
      sshRunner: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "remote help\n", stderr: "" };
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([sshRawHostForwardArgs("worker", ["--help"])]);
    expect(memory.output()).toEqual({ stdout: "remote help\n", stderr: "" });
  });
});

// Raw `--host` (#124): the remote command is no longer a bare `wux`, which fails
// with `env: 'wux': No such file or directory` when wux lives in ~/.local/bin off
// the non-interactive PATH. It is a self-contained resolver snippet that finds wux
// at runtime ON the remote (hint, ~/.local/bin/wux, login-shell, then PATH) and
// emits an actionable error on a genuine miss.
describe("raw-host wux resolution", () => {
  test("builds an SSH resolver command, not a bare wux, passing host+hint as positionals", () => {
    const argv = sshRawHostForwardArgs("worker", ["status"]);
    expect(argv.slice(0, argv.length - 1)).toEqual(["ssh", ...SSH_OPTS, "--", "worker"]);
    const remote = argv[argv.length - 1];
    // It is an `sh -c` wrapper, never the old bare `'env' ... 'wux'` shape.
    expect(remote.startsWith("'sh' '-c' ")).toBe(true);
    expect(remote).not.toContain("'env' 'WUX_FORCE_LOCAL=1' 'wux' 'status'");
    // Host and an (empty by default) hint ride as positionals after the snippet,
    // followed by the original wux args.
    expect(remote.endsWith("'wux' 'worker' '' 'status'")).toBe(true);
    // The resolver tries the documented locations in order and execs with the guard.
    expect(remote).toContain('"$HOME/.local/bin/wux"');
    expect(remote).toContain("command -v wux");
    expect(remote).toContain("bash -lc");
    expect(remote).toContain("exec env WUX_FORCE_LOCAL=1");
    // The not-found message names the host slot, the install remedy, and --host-wux.
    expect(remote).toContain("could not resolve a wux binary on host");
    expect(remote).toContain("--host-wux");
    expect(remote).toContain("WUX_REMOTE_WUX_PATH");
  });

  test("carries an explicit hint as the second positional", () => {
    const remote = sshRawHostForwardArgs("worker", ["status"], "/opt/wux/bin/wux").at(-1) as string;
    expect(remote.endsWith("'wux' 'worker' '/opt/wux/bin/wux' 'status'")).toBe(true);
  });

  test("host and hint are quoted positionals, immune to shell metacharacter injection", () => {
    // A hostile hint with quotes/semicolons can only land as $2 (a quoted positional),
    // never as executable snippet text.
    const remote = sshRawHostForwardArgs("worker", ["status"], "x'; rm -rf /; '").at(-1) as string;
    expect(remote).toContain("'wux' 'worker' 'x'\\''; rm -rf /; '\\''' 'status'");
  });

  // End-to-end shell execution of the EXACT production snippet (extracted from the
  // builder so it cannot drift), driven under /bin/sh with a controlled HOME/PATH.
  describe("resolver snippet executes correctly under /bin/sh", () => {
    // Decode the snippet + positionals from the builder's single quoted remote string.
    function remoteArgv(host: string, args: string[], hint = ""): string[] {
      const quoted = sshRawHostForwardArgs(host, args, hint).at(-1) as string;
      // Format: 'sh' '-c' '<snippet>' '<p0>' '<p1>' ... ; each token single-quoted with
      // the standard '\'' escape. Parse it back into raw tokens.
      const tokens: string[] = [];
      let i = 0;
      while (i < quoted.length) {
        if (quoted[i] === " ") {
          i += 1;
          continue;
        }
        if (quoted[i] !== "'") throw new Error(`unexpected token at ${i}: ${quoted.slice(i, i + 20)}`);
        i += 1;
        let value = "";
        while (i < quoted.length) {
          if (quoted[i] === "'") {
            // Either end of token, or the start of a '\'' escape sequence.
            if (quoted.slice(i, i + 4) === "'\\''") {
              value += "'";
              i += 4;
              continue;
            }
            i += 1;
            break;
          }
          value += quoted[i];
          i += 1;
        }
        tokens.push(value);
      }
      return tokens; // ["sh","-c",snippet,host-label,host,hint,...args]
    }

    function runSnippet(env: Record<string, string>, host: string, args: string[], hint = "") {
      const argv = remoteArgv(host, args, hint);
      const result = spawnSync(argv[0], argv.slice(1), { env, encoding: "utf8" });
      return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }

    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "wux124-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function installFakeWux(home: string, body: string): string {
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      const path = join(home, ".local", "bin", "wux");
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    }

    // /usr/bin:/bin gives the snippet sh/bash but (asserted) no wux of its own.
    const SYS_PATH = "/usr/bin:/bin";
    const noSystemWux = spawnSync("sh", ["-c", "command -v wux"], { env: { PATH: SYS_PATH }, encoding: "utf8" }).status !== 0;

    test("resolves wux from ~/.local/bin even when it is off the non-interactive PATH", () => {
      const home = join(dir, "home");
      installFakeWux(home, 'echo "FAKE_WUX status=$1"\necho "GUARD=$WUX_FORCE_LOCAL"');
      const out = runSnippet({ HOME: home, PATH: SYS_PATH }, "host-a", ["status"]);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("FAKE_WUX status=status");
      // The recursion guard is preserved across the resolved exec.
      expect(out.stdout).toContain("GUARD=1");
      expect(out.stderr).toBe("");
    });

    test("genuine absence yields an actionable error and exit 127, not a raw env failure", () => {
      if (!noSystemWux) return; // skip if the dev/CI machine has wux on /usr/bin:/bin
      const home = join(dir, "empty-home"); // no ~/.local/bin/wux
      mkdirSync(home, { recursive: true });
      const out = runSnippet({ HOME: home, PATH: SYS_PATH }, "host-b", ["status"]);
      expect(out.code).toBe(127);
      expect(out.stderr).toContain("could not resolve a wux binary on host 'host-b'");
      expect(out.stderr).toContain("--host-wux");
      expect(out.stderr).toContain("WUX_REMOTE_WUX_PATH");
      // Crucially, NOT the bare PATH-lookup failure this issue fixes.
      expect(out.stderr).not.toContain("env: 'wux'");
    });

    test("an explicit hint path is honored ahead of the location search", () => {
      const hintHome = join(dir, "hint-home");
      const hintWux = installFakeWux(hintHome, 'echo "HINT_WUX_RAN"');
      const out = runSnippet({ HOME: join(dir, "no-wux-home"), PATH: SYS_PATH }, "host-c", ["status"], hintWux);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("HINT_WUX_RAN");
    });

    // Order guard (#124 BLOCKING): the documented + spec'd order is hint ->
    // ~/.local/bin -> LOGIN-SHELL PATH -> bare non-interactive PATH. With ~/.local/bin
    // empty and DIFFERENT wux binaries on the login-shell PATH vs the non-interactive
    // PATH, the login-shell one MUST win. A swap (the bug) would run the
    // non-interactive one. This pins the order so it cannot silently drift.
    function writeFakeWuxAt(binDir: string, body: string): void {
      mkdirSync(binDir, { recursive: true });
      const path = join(binDir, "wux");
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
    }

    test("login-shell PATH wins over a different wux on the non-interactive PATH", () => {
      if (!noSystemWux) return; // a system wux on /usr/bin:/bin would shadow the controlled setup
      const home = join(dir, "order-home"); // no ~/.local/bin/wux -> skip step 2
      mkdirSync(home, { recursive: true });
      // A wux visible ONLY to a login shell (via ~/.bash_profile prepending its dir).
      const loginBin = join(dir, "login-bin");
      writeFakeWuxAt(loginBin, 'echo "LOGIN_WUX_RAN"');
      writeFileSync(join(home, ".bash_profile"), `export PATH="${loginBin}:$PATH"\n`);
      // A DIFFERENT wux on the non-interactive PATH (the bare `command -v wux` leg).
      const noninteractiveBin = join(dir, "noninteractive-bin");
      writeFakeWuxAt(noninteractiveBin, 'echo "NONINTERACTIVE_WUX_RAN"');

      const out = runSnippet({ HOME: home, PATH: `${noninteractiveBin}:${SYS_PATH}` }, "host-order", ["status"]);
      expect(out.code).toBe(0);
      // Correct order resolves the login-shell wux; a swapped loop would run the
      // non-interactive one instead.
      expect(out.stdout).toContain("LOGIN_WUX_RAN");
      expect(out.stdout).not.toContain("NONINTERACTIVE_WUX_RAN");
    });
  });
});
