import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killPrivateTmuxServer } from "./helpers";

test("preload isolates tmux and refuses server cleanup outside test roots", async () => {
  expect(process.env.TMUX).toBeUndefined();
  expect(process.env.TMUX_PANE).toBeUndefined();
  expect(process.env.TMUX_TMPDIR).toBe(process.env.WUX_TEST_TMUX_ROOT);
  expect(process.env.WUX_TEST_TMUX_ROOT).toStartWith("/tmp/wux-test-tmux-");

  const root = await mkdtemp(join(tmpdir(), "wux-test-isolation-"));
  const allowedRoot = join(root, "allowed");
  const outsideSocket = join(root, "outside.socket");
  const calls: string[][] = [];
  try {
    await mkdir(allowedRoot);
    await writeFile(outsideSocket, "placeholder");
    await expect(
      killPrivateTmuxServer(outsideSocket, allowedRoot, async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }),
    ).rejects.toThrow("refusing to kill tmux server outside test-owned roots");
    expect(calls).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
