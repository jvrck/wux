import { afterAll } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { killPrivateTmuxServer } from "./helpers";

// tmux Unix-domain sockets have a short path limit. Keep this parent directly
// under /tmp rather than using Bun's longer per-user temporary directory.
const tmuxRoot = await mkdtemp("/tmp/wux-test-tmux-");

delete process.env.TMUX;
delete process.env.TMUX_PANE;
delete process.env.WUX_FORCE_LOCAL;
process.env.TMUX_TMPDIR = tmuxRoot;
process.env.WUX_TEST_TMUX_ROOT = tmuxRoot;

async function findSockets(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sockets: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sockets.push(...(await findSockets(path)));
    } else if (entry.isSocket()) {
      sockets.push(path);
    }
  }
  return sockets;
}

afterAll(async () => {
  try {
    for (const socketPath of await findSockets(tmuxRoot)) {
      await killPrivateTmuxServer(socketPath, tmuxRoot).catch(() => undefined);
    }
  } finally {
    await rm(tmuxRoot, { recursive: true, force: true });
  }
});
