import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupPrivateTmuxServers, killPrivateTmuxServer } from "./helpers";

test("preload isolates tmux and refuses server cleanup outside test roots", async () => {
  expect(process.env.TMUX).toBeUndefined();
  expect(process.env.TMUX_PANE).toBeUndefined();
  expect(process.env.WUX_FORCE_LOCAL).toBeUndefined();
  expect(process.env.TMUX_TMPDIR).toBe(process.env.WUX_TEST_TMUX_ROOT);
  expect(process.env.WUX_TEST_TMUX_ROOT).toStartWith("/tmp/wux-test-tmux-");

  const root = await mkdtemp(join(tmpdir(), "wux-test-isolation-"));
  const allowedRoot = join(root, "allowed");
  const outsideSocket = join(root, "outside.socket");
  const allowedSocket = join(allowedRoot, "allowed.socket");
  const failedSocket = join(allowedRoot, "failed.socket");
  const suiteRoot = process.env.WUX_TEST_TMUX_ROOT as string;
  const suiteSocket = join(suiteRoot, `helper-${process.pid}.socket`);
  const siblingRoot = `${suiteRoot}-x`;
  const siblingSocket = join(siblingRoot, "sibling.socket");
  const missingSocket = join(allowedRoot, "missing.socket");
  const realRoot = join(root, "real");
  const linkRoot = join(root, "link");
  const symlinkedMissingSocket = join(linkRoot, "missing", "socket");
  const outsideMissingSocket = join(root, "outside", "socket");
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await mkdir(allowedRoot);
    await mkdir(siblingRoot);
    await mkdir(realRoot);
    await symlink(realRoot, linkRoot);
    await writeFile(outsideSocket, "placeholder");
    await writeFile(allowedSocket, "placeholder");
    await writeFile(failedSocket, "placeholder");
    await writeFile(suiteSocket, "placeholder");
    await writeFile(siblingSocket, "placeholder");
    expect(await killPrivateTmuxServer(allowedSocket, allowedRoot, runner)).toMatchObject({ code: 0 });
    expect(await killPrivateTmuxServer(suiteSocket, allowedRoot, runner)).toMatchObject({ code: 0 });
    expect(calls).toEqual([
      ["tmux", "-S", await realpath(allowedSocket), "kill-server"],
      ["tmux", "-S", await realpath(suiteSocket), "kill-server"],
    ]);
    await expect(
      killPrivateTmuxServer(outsideSocket, allowedRoot, runner),
    ).rejects.toThrow("refusing to kill tmux server outside test-owned roots");
    await expect(killPrivateTmuxServer(suiteRoot, allowedRoot, runner)).rejects.toThrow("refusing to kill tmux server outside test-owned roots");
    await expect(killPrivateTmuxServer(siblingSocket, allowedRoot, runner)).rejects.toThrow("refusing to kill tmux server outside test-owned roots");
    await expect(
      killPrivateTmuxServer(failedSocket, allowedRoot, async () => ({ code: 1, stdout: "", stderr: "server refused" })),
    ).rejects.toThrow("failed to kill private tmux server");
    expect(await killPrivateTmuxServer(missingSocket, allowedRoot, runner)).toMatchObject({ code: 0 });
    expect(await killPrivateTmuxServer(symlinkedMissingSocket, linkRoot, runner)).toMatchObject({ code: 0 });
    await expect(killPrivateTmuxServer(outsideMissingSocket, linkRoot, runner)).rejects.toThrow("refusing to kill tmux server outside test-owned roots");
    expect(calls).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(siblingRoot, { recursive: true, force: true });
    await rm(suiteSocket, { force: true });
  }
});

test("private tmux cleanup preserves a live socket after a failed kill", async () => {
  const root = await mkdtemp(join(tmpdir(), "wux-test-cleanup-"));
  const socketParent = join(root, "tmux");
  const socketPath = join(socketParent, "default");
  try {
    await mkdir(socketParent);
    await writeFile(socketPath, "placeholder");
    await expect(
      cleanupPrivateTmuxServers([socketPath], root, async () => ({ code: 1, stdout: "", stderr: "server refused" })),
    ).rejects.toThrow("failed to clean 1 private tmux socket");
    expect((await stat(socketParent)).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private tmux cleanup resolves a real socket parent and refuses a symlinked socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "wux-test-socket-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "wux-test-outside-"));
  const socketParent = join(root, "tmux");
  const socketPath = join(socketParent, "default");
  const symlinkedSocket = join(socketParent, "linked");
  const outsideSocket = join(outsideRoot, "socket");
  const server = createServer();
  const calls: string[][] = [];
  try {
    await mkdir(socketParent);
    await new Promise<void>((resolve, reject) => server.listen(socketPath, (error?: Error) => (error ? reject(error) : resolve())));
    await writeFile(outsideSocket, "outside");
    await symlink(outsideSocket, symlinkedSocket);
    const runner = async (args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await killPrivateTmuxServer(socketPath, root, runner)).toMatchObject({ code: 0 });
    expect(calls).toEqual([["tmux", "-S", join(await realpath(socketParent), "default"), "kill-server"]]);
    await expect(killPrivateTmuxServer(symlinkedSocket, root, runner)).rejects.toThrow("refusing to kill tmux server through symlinked socket");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("cleanup failure does not replace a test body failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "wux-test-cleanup-body-"));
  const socketParent = join(root, "tmux");
  const socketPath = join(socketParent, "default");
  const bodyFailure = new Error("body failed");
  let completed = false;
  let surfaced: unknown;
  try {
    await mkdir(socketParent);
    await writeFile(socketPath, "placeholder");
    try {
      throw bodyFailure;
    } finally {
      let cleanupError: unknown;
      try {
        await cleanupPrivateTmuxServers([socketPath], root, async () => ({ code: 1, stdout: "", stderr: "server refused" }));
      } catch (error) {
        cleanupError = error;
      }
      if (completed && cleanupError !== undefined) throw cleanupError;
    }
  } catch (error) {
    surfaced = error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  expect(surfaced).toBe(bodyFailure);
});
