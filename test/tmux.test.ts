import { describe, expect, test } from "bun:test";
import type { ProcessResult } from "../src/runtime/process";
import {
  connectionForMeta,
  discoverSocketPath,
  paneForegroundActivity,
  probeSession,
  socketTmuxConnection,
} from "../src/runtime/tmux";

test("centralizes exact socket qualification for relative and absolute tmux executables", async () => {
  for (const executable of ["tmux-custom", "/opt/tmux/bin/tmux"]) {
    const calls: string[][] = [];
    const connection = socketTmuxConnection("/tmp/wux.socket", {
      executable,
      runner: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "/tmp/wux.socket\n", stderr: "" };
      },
    });
    expect(await discoverSocketPath("wux_bound", connection)).toBe("/tmp/wux.socket");
    expect(calls).toEqual([
      [executable, "-S", "/tmp/wux.socket", "display-message", "-p", "-t", "=wux_bound:", "-F", "#{socket_path}"],
    ]);
  }
});

test("metadata absence is ambient while present invalid socket values fail closed", () => {
  expect(connectionForMeta({}).socketPath).toBeUndefined();
  for (const tmuxSocketPath of [undefined, "", "relative/socket", 42]) {
    expect(() => connectionForMeta({ tmuxSocketPath })).toThrow("invalid tmuxSocketPath");
  }
});

test("stored-socket liveness distinguishes absence from indeterminate unavailability", async () => {
  const probe = async (stderr: string) =>
    probeSession(
      "wux_bound",
      socketTmuxConnection("/tmp/wux.socket", { runner: async () => ({ code: 1, stdout: "", stderr }) }),
    );
  expect((await probe("can't find session: wux_bound")).state).toBe("absent");
  expect((await probe("no server running on /tmp/wux.socket")).state).toBe("absent");
  expect((await probe("error connecting to /tmp/wux.socket (Permission denied)")).state).toBe("unavailable");
});

test("socket qualification applies only to tmux while the ps probe stays separate", async () => {
  const tmuxCalls: string[][] = [];
  const processCalls: string[][] = [];
  const connection = socketTmuxConnection("/tmp/wux.socket", {
    executable: "/opt/tmux/bin/tmux",
    runner: async (args) => {
      tmuxCalls.push(args);
      const format = args[args.indexOf("-F") + 1];
      return { code: 0, stdout: format === "#{pane_pid}" ? "4242\n" : "zsh\n", stderr: "" };
    },
  });
  const activity = await paneForegroundActivity("wux_bound", {
    connection,
    processRunner: async (args) => {
      processCalls.push(args);
      return { code: 0, stdout: "/bin/zsh\n", stderr: "" };
    },
  });
  expect(activity).toBe("idle");
  expect(tmuxCalls.every((args) => args[0] === "/opt/tmux/bin/tmux" && args[1] === "-S" && args[2] === "/tmp/wux.socket")).toBe(true);
  expect(processCalls).toEqual([["ps", "-o", "comm=", "-p", "4242"]]);
});

// The probe reads pid and current command in two separate `display-message`
// calls (no in-band separator) so it is robust to tmux escaping non-printable
// bytes in format output — the tmux-3.4 behavior that broke the single-call
// separator parse on GitHub-hosted runners (#138). This mock dispatches by the
// `-F` format argument so each field can be answered independently.
function paneRunner(fields: { pid?: string; cmd?: string; code?: number }) {
  return async (args: string[]): Promise<ProcessResult> => {
    if (fields.code && fields.code !== 0) return { code: fields.code, stdout: "", stderr: "can't find pane" };
    const format = args[args.indexOf("-F") + 1] ?? "";
    if (format === "#{pane_pid}") return { code: 0, stdout: `${fields.pid ?? ""}\n`, stderr: "" };
    if (format === "#{pane_current_command}") return { code: 0, stdout: `${fields.cmd ?? ""}\n`, stderr: "" };
    return { code: 0, stdout: "\n", stderr: "" };
  };
}

describe("paneForegroundActivity", () => {
  test("queries pane_pid and pane_current_command with separate single-field display-message calls", async () => {
    const calls: string[][] = [];
    const activity = await paneForegroundActivity("wux_probe", {
      runner: async (args): Promise<ProcessResult> => {
        calls.push(args);
        const format = args[args.indexOf("-F") + 1] ?? "";
        if (format === "#{pane_pid}") return { code: 0, stdout: "4242\n", stderr: "" };
        return { code: 0, stdout: "zsh\n", stderr: "" };
      },
      commandName: async (pid) => {
        expect(pid).toBe(4242);
        return "zsh";
      },
    });

    expect(activity).toBe("idle");
    // Two single-field reads against the exact pane target — no in-band separator
    // for tmux to escape (the #138 root cause).
    expect(calls).toEqual([
      ["tmux", "display-message", "-p", "-t", "=wux_probe:", "-F", "#{pane_pid}"],
      ["tmux", "display-message", "-p", "-t", "=wux_probe:", "-F", "#{pane_current_command}"],
    ]);
  });

  test("reports foreground-busy when a non-shell command holds the pane foreground", async () => {
    const activity = await paneForegroundActivity("wux_busy", {
      runner: paneRunner({ pid: "5151", cmd: "yes" }),
      commandName: async () => "zsh",
    });
    expect(activity).toBe("foreground-busy");
  });

  test("treats sleep (a non-CPU-busy foreground child) as foreground-busy, not idle", async () => {
    const activity = await paneForegroundActivity("wux_sleep", {
      runner: paneRunner({ pid: "6262", cmd: "sleep" }),
      commandName: async () => "bash",
    });
    expect(activity).toBe("foreground-busy");
  });

  test("matches the shell basename even when ps returns a full path (macOS form)", async () => {
    const activity = await paneForegroundActivity("wux_path", {
      runner: paneRunner({ pid: "7373", cmd: "zsh" }),
      // commandName is responsible for basename normalization; here it already
      // returns the normalized form, mirroring processCommandName's contract.
      commandName: async () => "zsh",
    });
    expect(activity).toBe("idle");
  });

  test("falls back to unknown when the tmux display-message call fails", async () => {
    const activity = await paneForegroundActivity("wux_gone", {
      runner: paneRunner({ code: 1 }),
      commandName: async () => {
        throw new Error("commandName must not run when tmux fails");
      },
    });
    expect(activity).toBe("unknown");
  });

  test("falls back to unknown when the pane shell name cannot be resolved", async () => {
    const activity = await paneForegroundActivity("wux_nops", {
      runner: paneRunner({ pid: "8484", cmd: "yes" }),
      commandName: async () => undefined,
    });
    expect(activity).toBe("unknown");
  });

  test("falls back to unknown when pane_pid is unparseable", async () => {
    const activity = await paneForegroundActivity("wux_badpid", {
      runner: paneRunner({ pid: "notapid", cmd: "zsh" }),
      commandName: async () => "zsh",
    });
    expect(activity).toBe("unknown");
  });

  test("falls back to unknown when the foreground command field is empty", async () => {
    const activity = await paneForegroundActivity("wux_nocmd", {
      runner: paneRunner({ pid: "9090", cmd: "" }),
      commandName: async () => "zsh",
    });
    expect(activity).toBe("unknown");
  });
});
