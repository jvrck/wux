import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killPrivateTmuxServer } from "./helpers";

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
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await mkdir(allowedRoot);
    await mkdir(siblingRoot);
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
    expect(calls).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(siblingRoot, { recursive: true, force: true });
    await rm(suiteSocket, { force: true });
  }
});
