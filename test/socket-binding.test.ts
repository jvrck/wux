import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../src/runtime/process";
import { hasTmux } from "./helpers";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function wux(args: string[], env: Record<string, string>): Promise<CommandResult> {
  const child = Bun.spawn([process.execPath, "run", "wux", "--", ...args], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env = { ...process.env, ...extra } as Record<string, string>;
  delete env.TMUX;
  delete env.TMUX_TMPDIR;
  return env;
}

describe("socket-bound tmux runs", () => {
  test("persists exact sockets and routes lifecycle commands without ambient tmux state", async () => {
    if (!(await hasTmux())) return;
    // tmux sockets have a short Unix-domain path limit; use /tmp rather than the
    // long macOS per-user temporary root.
    const root = await mkdtemp("/tmp/wux-socket-");
    const state = join(root, "state");
    const socketAParent = join(root, "tmux-a");
    const socketBParent = join(root, "tmux-b");
    const nameA = `socket-a-${process.pid}-${Date.now()}`;
    const nameB = `socket-b-${process.pid}-${Date.now()}`;
    let socketA: string | undefined;
    let socketB: string | undefined;

    try {
      await mkdir(socketAParent, { recursive: true });
      await mkdir(socketBParent, { recursive: true });
      const base = cleanEnv({ XDG_STATE_HOME: state });
      const aEnv = { ...base, TMUX_TMPDIR: socketAParent };
      const bEnv = { ...base, TMUX_TMPDIR: socketBParent };

      const createdA = await wux(["run", "shell", "--name", nameA, "--cwd", root], aEnv);
      if (createdA.code !== 0) throw new Error(`create A failed: ${createdA.stderr || createdA.stdout}`);
      const createdB = await wux(["run", "shell", "--name", nameB, "--cwd", root], bEnv);
      if (createdB.code !== 0) throw new Error(`create B failed: ${createdB.stderr || createdB.stdout}`);
      const metaA = JSON.parse(await readFile(join(state, "wux", "runs", nameA, "meta.json"), "utf8"));
      const metaB = JSON.parse(await readFile(join(state, "wux", "runs", nameB, "meta.json"), "utf8"));
      socketA = metaA.tmuxSocketPath;
      socketB = metaB.tmuxSocketPath;
      expect(typeof socketA).toBe("string");
      expect(typeof socketB).toBe("string");
      if (!socketA || !socketB) throw new Error("new runs did not persist their tmux sockets");
      expect(socketA).not.toBe(socketB);

      // A same-named session on B must not be accepted as A, or be stopped with A.
      expect((await runProcess(["tmux", "-S", socketB, "new-session", "-d", "-s", metaA.tmuxSession, "sh"])).code).toBe(0);

      expect((await wux(["status"], base)).stdout).toContain(nameA);
      expect((await wux(["send", nameA, "printf 'SOCKET_A_OK\\n'"], base)).code).toBe(0);
      expect((await wux(["send", nameB, "printf 'SOCKET_B_OK\\n'"], base)).code).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect((await wux(["read", nameA, "--tail", "20"], base)).stdout).toContain("SOCKET_A_OK");
      expect((await wux(["read", nameB, "--tail", "20"], base)).stdout).toContain("SOCKET_B_OK");
      expect((await wux(["wait", nameA, "--idle", "100ms", "--timeout", "2s"], base)).code).toBe(0);

      expect((await wux(["send", nameB, "sleep 30"], base)).code).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await wux(["interrupt", nameB], base)).code).toBe(0);

      expect((await wux(["stop", nameA, "--yes"], base)).code).toBe(0);
      expect((await runProcess(["tmux", "-S", socketB, "has-session", "-t", `=${metaA.tmuxSession}`])).code).toBe(0);
      expect((await wux(["stop", nameB, "--yes"], base)).code).toBe(0);

      // An unavailable stored socket must not fall back to the caller's B server.
      const missingName = `socket-missing-${process.pid}-${Date.now()}`;
      expect((await wux(["run", "shell", "--name", missingName, "--cwd", root], aEnv)).code).toBe(0);
      const missingMeta = JSON.parse(await readFile(join(state, "wux", "runs", missingName, "meta.json"), "utf8"));
      expect((await runProcess(["tmux", "-S", socketB, "new-session", "-d", "-s", missingMeta.tmuxSession, "sh"])).code).toBe(0);
      expect((await runProcess(["tmux", "-S", socketA, "kill-server"])).code).toBe(0);
      expect((await wux(["status"], bEnv)).stdout).toContain(`${missingName}`);
      expect((await wux(["status"], bEnv)).stdout).toContain("unknown");
      expect((await wux(["stop", missingName, "--yes"], bEnv)).code).toBe(0);
      expect((await runProcess(["tmux", "-S", socketB, "has-session", "-t", `=${missingMeta.tmuxSession}`])).code).toBe(0);
      socketA = undefined;
    } finally {
      // Both servers are created under this test's private temporary parents.
      if (socketA) await runProcess(["tmux", "-S", socketA, "kill-server"]);
      if (socketB) await runProcess(["tmux", "-S", socketB, "kill-server"]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
