import { describe, expect, test } from "bun:test";
import { viewCommand } from "../src/commands/view";
import { saveRun } from "../src/runtime/runs";
import { renderShellCommand } from "../src/runtime/shell";
import { tempState } from "./helpers";

describe("view", () => {
  test("keeps its stable tmux target and POSIX-quotes a socket command", async () => {
    const temp = await tempState();
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    try {
      await saveRun({
        name: "quoted-view",
        backend: "shell",
        tmuxSession: "wux_quoted-view",
        tmuxSocketPath: "/tmp/wux$(id)'quoted/tmux-501/default",
        cwd: temp.root,
        owner: "test@test",
        createdAt: new Date().toISOString(),
        status: "running",
      });
      const view = await viewCommand({ name: "quoted-view" });
      expect(view.tmuxTarget).toBe("=wux_quoted-view:");
      expect(view.tmuxCommand).toBe(
        renderShellCommand(["tmux", "-S", "/tmp/wux$(id)'quoted/tmux-501/default", "attach-session", "-t", "=wux_quoted-view"]),
      );
    } finally {
      process.env.XDG_STATE_HOME = previous;
      await temp.cleanup();
    }
  });

  test("keeps legacy metadata on the ambient tmux contract", async () => {
    const temp = await tempState();
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    try {
      await saveRun({
        name: "legacy-view",
        backend: "shell",
        tmuxSession: "wux_legacy-view",
        cwd: temp.root,
        owner: "test@test",
        createdAt: new Date().toISOString(),
        status: "running",
      });
      const view = await viewCommand({ name: "legacy-view" });
      expect(view.tmuxTarget).toBe("=wux_legacy-view:");
      expect(view.tmuxSocketPath).toBeUndefined();
      expect(view.tmuxCommand).toBeUndefined();
    } finally {
      process.env.XDG_STATE_HOME = previous;
      await temp.cleanup();
    }
  });
});
