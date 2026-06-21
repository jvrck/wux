import { describe, expect, test } from "bun:test";
import type { ProcessResult } from "../src/runtime/process";
import { paneForegroundActivity } from "../src/runtime/tmux";

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
