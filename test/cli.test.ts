import { describe, expect, test } from "bun:test";
import { __test, commandHelp, help, parseGlobal, runCli } from "../src/cli";
import { tempConfig } from "./helpers";

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
  const shouldIsolateConfig = process.env.XDG_CONFIG_HOME === undefined;
  const temp = shouldIsolateConfig ? await tempConfig() : undefined;
  const oldConfig = process.env.XDG_CONFIG_HOME;
  if (temp) process.env.XDG_CONFIG_HOME = temp.configHome;
  const memory = memoryIO();
  try {
    const code = await runCli(args, memory.io);
    return { code, ...memory.output() };
  } finally {
    if (oldConfig === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = oldConfig;
    }
    await temp?.cleanup();
  }
}

describe("help", () => {
  test("root help lists the v1 command surface", () => {
    const text = help();
    for (const command of ["run", "send", "read", "status", "wait", "mark", "attach", "stop", "interrupt", "handoff", "prune", "remotes", "skills"]) {
      expect(text).toContain(command);
    }
  });

  test("command help describes required arguments", () => {
    expect(commandHelp("run")).toContain("<backend>");
    expect(commandHelp("run")).toContain("--json");
    expect(commandHelp("send")).toContain("<run-name>");
    // --json is only recognized before the literal text; the usage must reflect that.
    expect(commandHelp("send")).toContain("[--json] <text>");
    expect(commandHelp("read")).toContain("--json");
    expect(commandHelp("read")).toContain("--follow");
    expect(commandHelp("status")).toContain("--json");
    expect(commandHelp("wait")).toContain("completedVia");
    expect(commandHelp("skills")).toContain("skills show <name>");
    expect(commandHelp("interrupt")).toContain("<run-name>");
    expect(commandHelp("interrupt")).toContain("--force-owner");
    expect(commandHelp("nope")).toBeUndefined();
  });
});

describe("global parsing", () => {
  test("parses target selectors before the command", () => {
    expect(parseGlobal(["--host", "worker", "status"])).toEqual({
      globals: { host: "worker", local: false, help: false, version: false },
      command: "status",
      args: [],
    });
    expect(parseGlobal(["--host=worker", "status"])).toEqual({
      globals: { host: "worker", local: false, help: false, version: false },
      command: "status",
      args: [],
    });
    expect(parseGlobal(["--remote", "work", "status"])).toEqual({
      globals: { remote: "work", local: false, help: false, version: false },
      command: "status",
      args: [],
    });
    expect(parseGlobal(["--remote=work", "status"])).toEqual({
      globals: { remote: "work", local: false, help: false, version: false },
      command: "status",
      args: [],
    });
    expect(parseGlobal(["--local", "status"])).toEqual({
      globals: { local: true, help: false, version: false },
      command: "status",
      args: [],
    });
  });

  test("rejects missing host values", () => {
    expect(() => parseGlobal(["--host"])).toThrow("--host requires <host>");
    expect(() => parseGlobal(["--host", "--help"])).toThrow("--host requires <host>");
    expect(() => parseGlobal(["--host="])).toThrow("--host requires <host>");
  });

  test("rejects missing remote values", () => {
    expect(() => parseGlobal(["--remote"])).toThrow("--remote requires <name>");
    expect(() => parseGlobal(["--remote", "--help"])).toThrow("--remote requires <name>");
    expect(() => parseGlobal(["--remote="])).toThrow("--remote requires <name>");
  });

  test("rejects option-like host values", () => {
    expect(() => parseGlobal(["--host", "-x", "status"])).toThrow("--host requires <host>");
    expect(() => parseGlobal(["--host=-x", "status"])).toThrow("--host requires <host>");
    expect(() => parseGlobal(["--host=-oProxyCommand=touch${IFS}/tmp/wux_pwned", "status"])).toThrow(
      "--host requires <host>",
    );
  });

  test("rejects mutually exclusive target selectors", () => {
    expect(() => parseGlobal(["--local", "--host", "worker", "status"])).toThrow(
      "--local, --remote, and --host are mutually exclusive",
    );
    expect(() => parseGlobal(["--remote", "work", "--host", "worker", "status"])).toThrow(
      "--local, --remote, and --host are mutually exclusive",
    );
    expect(() => parseGlobal(["--local", "--remote", "work", "status"])).toThrow(
      "--local, --remote, and --host are mutually exclusive",
    );
  });

  test("parses --host-wux as a raw-host hint alongside --host (#124)", () => {
    expect(parseGlobal(["--host", "worker", "--host-wux", "/opt/wux", "status"])).toEqual({
      globals: { host: "worker", hostWux: "/opt/wux", local: false, help: false, version: false },
      command: "status",
      args: [],
    });
    expect(parseGlobal(["--host", "worker", "--host-wux=/opt/wux", "status"])).toEqual({
      globals: { host: "worker", hostWux: "/opt/wux", local: false, help: false, version: false },
      command: "status",
      args: [],
    });
  });

  test("rejects --host-wux without --host and with missing/option-like values (#124)", () => {
    expect(() => parseGlobal(["--host-wux", "/opt/wux", "status"])).toThrow("--host-wux requires --host <host>");
    expect(() => parseGlobal(["--remote", "work", "--host-wux", "/opt/wux", "status"])).toThrow(
      "--host-wux requires --host <host>",
    );
    expect(() => parseGlobal(["--host", "worker", "--host-wux"])).toThrow("--host-wux requires <path>");
    expect(() => parseGlobal(["--host", "worker", "--host-wux", "-x"])).toThrow("--host-wux requires <path>");
    expect(() => parseGlobal(["--host", "worker", "--host-wux="])).toThrow("--host-wux requires <path>");
  });

  test("remoteWuxHintFromEnv reads WUX_REMOTE_WUX_PATH and treats blank as unset (#124)", () => {
    expect(__test.remoteWuxHintFromEnv({})).toBeUndefined();
    expect(__test.remoteWuxHintFromEnv({ WUX_REMOTE_WUX_PATH: "" })).toBeUndefined();
    expect(__test.remoteWuxHintFromEnv({ WUX_REMOTE_WUX_PATH: "   " })).toBeUndefined();
    expect(__test.remoteWuxHintFromEnv({ WUX_REMOTE_WUX_PATH: "/p/wux" })).toBe("/p/wux");
    expect(__test.remoteWuxHintFromEnv({ WUX_REMOTE_WUX_PATH: "  /p/wux  " })).toBe("/p/wux");
  });
});

describe("dispatch", () => {
  test("prints root and command help", async () => {
    expect(await run(["--help"])).toMatchObject({ code: 0, stderr: "" });
    const command = await run(["run", "--help"]);
    expect(command.code).toBe(0);
    expect(command.stdout).toContain("wux run <backend>");
  });

  test("prints command help when help appears after partial command args", async () => {
    expect(await run(["run", "shell", "--help"])).toMatchObject({ code: 0, stderr: "" });
  });

  test("rejects unknown commands and options", async () => {
    expect(await run(["nope"])).toMatchObject({ code: 1, stderr: "wux: unknown command: nope\n" });
    expect(await run(["--wat"])).toMatchObject({ code: 1, stderr: "wux: unknown option: --wat\n" });
  });

  test("json commands report failures with the shared error envelope on stdout", async () => {
    const oldState = process.env.XDG_STATE_HOME;
    const temp = await import("./helpers").then((helpers) => helpers.tempState());
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      const result = await run(["--local", "read", "missing-json-error", "--json"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        error: {
          code: "run-not-found",
          message: "run not found: missing-json-error",
        },
      });
    } finally {
      process.env.XDG_STATE_HOME = oldState;
      await temp.cleanup();
    }
  });

  test("status json is an empty array with no runs and duplicate json flags are rejected", async () => {
    const oldState = process.env.XDG_STATE_HOME;
    const temp = await import("./helpers").then((helpers) => helpers.tempState());
    process.env.XDG_STATE_HOME = temp.stateHome;

    try {
      const empty = await run(["--local", "status", "--json"]);
      expect(empty.code).toBe(0);
      expect(JSON.parse(empty.stdout)).toEqual([]);
      expect(empty.stderr).toBe("");

      for (const args of [
        ["--local", "status", "--json", "--json"],
        ["--local", "read", "missing-run", "--json", "--json"],
        ["--local", "run", "shell", "--name", "dup-json", "--cwd", temp.root, "--json", "--json"],
      ]) {
        const result = await run(args);
        expect(result.code).toBe(1);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          error: {
            code: "bad-args",
            message: "unknown option: --json",
          },
        });
      }
    } finally {
      process.env.XDG_STATE_HOME = oldState;
      await temp.cleanup();
    }
  });

  test("validates required command arguments before placeholders run", async () => {
    expect(await run(["run", "shell"])).toMatchObject({ code: 1, stderr: "wux: run requires --name <run-name>\n" });
    expect(await run(["run", "docker", "--name", "r", "--cwd", "."])).toMatchObject({ code: 1, stderr: "wux: invalid backend: docker\n" });
    expect(await run(["mark", "r", "paused"])).toMatchObject({ code: 1, stderr: "wux: invalid status: paused\n" });
    expect(await run(["stop", "--yes"])).toMatchObject({ code: 1, stderr: "wux: stop requires <run-name>\n" });
    expect(await run(["prune", "--days", "0"])).toMatchObject({ code: 1, stderr: "wux: --days must be a positive integer\n" });
    expect(await run(["prune", "--days", "-1"])).toMatchObject({ code: 1, stderr: "wux: --days must be a positive integer\n" });
    expect(await run(["run", "shell", "--name", "r", "--cwd", "--owner"])).toMatchObject({
      code: 1,
      stderr: "wux: --cwd requires a value\n",
    });
  });

  test("splits backend passthrough at the first -- and leaves wux flags otherwise intact", () => {
    // No --: undefined (byte-identical to the pre-passthrough path); args untouched.
    const noTerminator = ["--name", "x", "--cwd", "P"];
    expect(__test.takeBackendArgs(noTerminator)).toBeUndefined();
    expect(noTerminator).toEqual(["--name", "x", "--cwd", "P"]);

    // --: everything after is passthrough; the wux flags before it remain for parsing.
    const withTerminator = ["--name", "x", "--cwd", "P", "--", "--dangerously-skip-permissions", "--model", "opus"];
    expect(__test.takeBackendArgs(withTerminator)).toEqual(["--dangerously-skip-permissions", "--model", "opus"]);
    expect(withTerminator).toEqual(["--name", "x", "--cwd", "P"]);

    // Backend args that look like wux options are not re-read as wux flags.
    const collidingFlags = ["--name", "x", "--cwd", "P", "--", "--name", "not-wux", "--json"];
    expect(__test.takeBackendArgs(collidingFlags)).toEqual(["--name", "not-wux", "--json"]);
    expect(collidingFlags).toEqual(["--name", "x", "--cwd", "P"]);

    // A trailing -- with nothing after it yields empty passthrough.
    const emptyTail = ["--name", "x", "--cwd", "P", "--"];
    expect(__test.takeBackendArgs(emptyTail)).toEqual([]);
    expect(emptyTail).toEqual(["--name", "x", "--cwd", "P"]);

    // Only the FIRST -- terminates; later --s are literal passthrough.
    const nested = ["--cwd", "P", "--", "shell", "--", "nested"];
    expect(__test.takeBackendArgs(nested)).toEqual(["shell", "--", "nested"]);
    expect(nested).toEqual(["--cwd", "P"]);
  });

  test("run forwards a -- passthrough to the remote verbatim", async () => {
    const memory = memoryIO();
    const calls: string[][] = [];
    const code = await runCli(
      ["--host", "worker", "run", "claude", "--name", "x", "--cwd", "P", "--", "--dangerously-skip-permissions"],
      memory.io,
      {
        sshRunner: async (args: string[]) => {
          calls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(code).toBe(0);
    const forwarded = calls[0][calls[0].length - 1];
    expect(forwarded).toContain("'run' 'claude' '--name' 'x' '--cwd' 'P' '--' '--dangerously-skip-permissions'");
  });

  test("host forwarding preserves remote exit status without local error decoration", async () => {
    const memory = memoryIO();
    const code = await runCli(["--host", "worker", "status"], memory.io, {
      sshRunner: async () => ({ code: 23, stdout: "remote status\n", stderr: "remote problem\n" }),
    });

    expect(code).toBe(23);
    expect(memory.output()).toEqual({
      stdout: "remote status\n",
      stderr: "remote problem\n",
    });
  });

  test("interrupt is operational and forwards over --host with its arguments", async () => {
    const memory = memoryIO();
    const calls: string[][] = [];
    const code = await runCli(["--host", "worker", "interrupt", "run-name", "--force-owner"], memory.io, {
      sshRunner: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(code).toBe(0);
    expect(calls.length).toBe(1);
    // Raw --host wraps the wux command in the remote resolver snippet (see
    // ssh-transport.test.ts), so the forwarded args appear as positionals after it.
    expect(calls[0][calls[0].length - 1]).toContain("'interrupt' 'run-name' '--force-owner'");
  });

  test("wait is operational and forwards over --host with its arguments", async () => {
    const memory = memoryIO();
    const calls: string[][] = [];
    const code = await runCli(["--host", "worker", "wait", "run-name", "--idle", "1s", "--timeout", "10s", "--json"], memory.io, {
      sshRunner: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(code).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0][calls[0].length - 1]).toContain("'wait' 'run-name' '--idle' '1s' '--timeout' '10s' '--json'");
  });

  test("read --follow is operational and forwards over --host with its arguments", async () => {
    const memory = memoryIO();
    const calls: string[][] = [];
    const code = await runCli(["--host", "worker", "read", "--follow", "run-name", "--poll-interval-ms", "100"], memory.io, {
      sshRunner: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(code).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0][calls[0].length - 1]).toContain("'read' '--follow' 'run-name' '--poll-interval-ms' '100'");
  });

  test("long-running forwarding is not capped by the generic SSH command timeout", () => {
    expect(__test.forwardTimeoutForCommand("attach")).toBe(0);
    expect(__test.forwardTimeoutForCommand("wait")).toBe(0);
    expect(__test.forwardTimeoutForCommand("read", ["--follow", "run-name"])).toBe(0);
    expect(__test.forwardTimeoutForCommand("read", ["run-name", "--follow"])).toBe(0);
    expect(__test.forwardTimeoutForCommand("read", ["run-name"])).toBeUndefined();
    expect(__test.forwardTimeoutForCommand("status")).toBeUndefined();
  });

  test("command help stays local with a configured default remote", async () => {
    const oldConfig = process.env.XDG_CONFIG_HOME;
    const temp = await tempConfig();
    process.env.XDG_CONFIG_HOME = temp.configHome;

    try {
      await run(["remotes", "add", "work", "worker", "--default"]);
      const memory = memoryIO();
      const calls: string[][] = [];
      const code = await runCli(["run", "--help"], memory.io, {
        sshRunner: async (args) => {
          calls.push(args);
          return { code: 0, stdout: "remote\n", stderr: "" };
        },
      });

      expect(code).toBe(0);
      expect(calls).toEqual([]);
      expect(memory.output().stdout).toContain("wux run <backend>");
    } finally {
      if (oldConfig === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = oldConfig;
      }
      await temp.cleanup();
    }
  });

  test("explicit local bypasses configured default remote", async () => {
    const oldConfig = process.env.XDG_CONFIG_HOME;
    const oldState = process.env.XDG_STATE_HOME;
    const temp = await import("./helpers").then((helpers) => helpers.tempConfig());
    process.env.XDG_CONFIG_HOME = temp.configHome;
    process.env.XDG_STATE_HOME = temp.root;

    try {
      await run(["remotes", "add", "work", "worker", "--default"]);
      const memory = memoryIO();
      const calls: string[][] = [];
      const code = await runCli(["--local", "status"], memory.io, {
        sshRunner: async (args) => {
          calls.push(args);
          return { code: 0, stdout: "remote\n", stderr: "" };
        },
      });

      expect(code).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      process.env.XDG_CONFIG_HOME = oldConfig;
      process.env.XDG_STATE_HOME = oldState;
      await temp.cleanup();
    }
  });

  test("send parsing accepts dash-prefixed text with an option terminator", () => {
    expect(__test.parseSendArgs(["r", "--", "--force-owner"])).toEqual({ name: "r", text: "--force-owner", forceOwner: false, json: false });
    expect(__test.parseSendArgs(["r", "hello", "--force-owner"])).toEqual({ name: "r", text: "hello", forceOwner: true, json: false });
    expect(__test.parseSendArgs(["r", "--", "--help"])).toEqual({ name: "r", text: "--help", forceOwner: false, json: false });
    expect(__test.parseSendArgs(["r", "--force-owner", "--", "--amend"])).toEqual({ name: "r", text: "--amend", forceOwner: true, json: false });
  });

  test("send parsing recognizes --json only before the literal text", () => {
    expect(__test.parseSendArgs(["r", "--json", "hi"])).toEqual({ name: "r", text: "hi", forceOwner: false, json: true });
    expect(__test.parseSendArgs(["r", "--json", "--force-owner", "hi"])).toEqual({ name: "r", text: "hi", forceOwner: true, json: true });
    // --json after the terminator is literal text, not the flag.
    expect(__test.parseSendArgs(["r", "--", "--json"])).toEqual({ name: "r", text: "--json", forceOwner: false, json: false });
    expect(__test.parseSendArgs(["r", "--force-owner", "--json", "--", "--amend"])).toEqual({ name: "r", text: "--amend", forceOwner: true, json: true });
  });

  test("send parsing rejects option-like text without a terminator", () => {
    expect(() => __test.parseSendArgs(["r", "--bogus"])).toThrow("unknown option: --bogus");
    expect(() => __test.parseSendArgs(["r", "--force-owner", "--force-owner"])).toThrow("unknown option: --force-owner");
    // --json must precede the literal text; a trailing --json is rejected, not enabled.
    expect(() => __test.parseSendArgs(["r", "hi", "--json"])).toThrow("unexpected argument: --json");
  });

  test("read parsing accepts follow before or after the run name and rejects structured follow", () => {
    expect(__test.parseReadArgs(["--follow", "r"])).toEqual({ name: "r", json: false, follow: true });
    expect(__test.parseReadArgs(["r", "--follow", "--poll-interval-ms", "100"])).toEqual({
      name: "r",
      json: false,
      follow: true,
      pollIntervalMs: 100,
    });
    expect(__test.parseReadArgs(["r", "--tail", "5", "--json"])).toEqual({ name: "r", tail: 5, json: true, follow: false });
    expect(() => __test.parseReadArgs(["--follow", "--json", "r"])).not.toThrow();
    expect(() => __test.parseReadArgs(["--follow", "r", "--grep", "needle"])).toThrow("unknown option: --grep");
  });

  test("read --follow rejects json output before loading the run", async () => {
    const result = await run(["--local", "read", "--follow", "--json", "missing-follow-json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: "bad-args",
        message: "--follow cannot be combined with --json",
      },
    });
  });

  test("read rejects follow-only interval option without follow mode", async () => {
    const result = await run(["--local", "read", "missing-interval", "--poll-interval-ms", "100"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("wux: --poll-interval-ms requires --follow\n");
    expect(result.stdout).toBe("");
  });

  test("renderSendResult routes verdicts to stdout success, stderr warning, or json", () => {
    const base = { name: "r", bytes: 5 } as const;
    expect(__test.renderSendResult({ ...base, submission: "submitted", retried: false }, false)).toEqual({
      stdout: "sent 5 bytes to r (submitted)\n",
    });
    const warn = __test.renderSendResult({ ...base, submission: "not-submitted", retried: true }, false);
    expect(warn.stdout).toBeUndefined();
    expect(warn.stderr).toContain("warning");
    expect(warn.stderr).toContain("not-submitted");
    expect(warn.stderr).toContain("retried");
    const uncertain = __test.renderSendResult({ ...base, submission: "uncertain", retried: false }, false);
    expect(uncertain.stdout).toBeUndefined();
    expect(uncertain.stderr).toContain("uncertain");
    const json = __test.renderSendResult({ ...base, submission: "not-submitted", retried: true }, true);
    expect(json.stderr).toBeUndefined();
    expect(JSON.parse(json.stdout as string)).toEqual({ name: "r", submission: "not-submitted", retried: true, bytes: 5 });
  });
});
