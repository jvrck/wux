import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runProcess, type ProcessResult } from "../src/runtime/process";

export async function hasTmux(): Promise<boolean> {
  return (await runProcess(["tmux", "-V"])).code === 0;
}

// Poll an argv sentinel file written by a fake backend (one token per line) until
// it lists at least `minTokens` entries, then return the tokens. Lets a test
// assert what the launched process ACTUALLY received through the tmux launch path
// (catching quoting/splitting regressions), not just what wux recorded in meta.
export async function waitForArgv(path: string, minTokens = 1, timeoutMs = 5000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tokens: string[] = [];
    try {
      const raw = await readFile(path, "utf8");
      tokens = raw.split("\n").filter((line) => line.length > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (tokens.length >= minTokens) return tokens;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for >=${minTokens} argv token(s) in ${path}; saw ${tokens.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function killTmux(runName: string): Promise<void> {
  await runProcess(["tmux", "kill-session", "-t", `=wux_${runName}`]);
}

type TmuxRunner = (args: string[]) => Promise<ProcessResult>;

function isStrictlyInside(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot.length > 0 && !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && pathFromRoot !== "..";
}

export async function killPrivateTmuxServer(socketPath: string, allowedRoot: string, runner: TmuxRunner = runProcess): Promise<void> {
  const [resolvedSocket, resolvedAllowedRoot, testRoot] = await Promise.all([
    realpath(socketPath),
    realpath(allowedRoot),
    process.env.WUX_TEST_TMUX_ROOT ? realpath(process.env.WUX_TEST_TMUX_ROOT) : undefined,
  ]);
  const allowed = isStrictlyInside(resolvedSocket, resolvedAllowedRoot) || (testRoot !== undefined && isStrictlyInside(resolvedSocket, testRoot));
  if (!allowed) {
    throw new Error(`refusing to kill tmux server outside test-owned roots: ${resolvedSocket}`);
  }
  await runner(["tmux", "-S", resolvedSocket, "kill-server"]);
}

export async function tempState(): Promise<{ root: string; stateHome: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "wux-test-"));
  const stateHome = join(root, "state");
  return {
    root,
    stateHome,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function tempConfig(): Promise<{ root: string; configHome: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "wux-test-"));
  const configHome = join(root, "config");
  return {
    root,
    configHome,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
