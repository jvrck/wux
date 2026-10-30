import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const TEST_KEEPALIVE_SESSION = "wux_test_keepalive";

async function ensureTestTmuxServer(): Promise<void> {
  if ((await runProcess(["tmux", "has-session", "-t", `=${TEST_KEEPALIVE_SESSION}`])).code === 0) return;
  const created = await runProcess(["tmux", "new-session", "-d", "-s", TEST_KEEPALIVE_SESSION, "sh"]);
  if (created.code !== 0 && (await runProcess(["tmux", "has-session", "-t", `=${TEST_KEEPALIVE_SESSION}`])).code !== 0) {
    throw new Error(`failed to keep private tmux server alive: ${created.stderr || created.stdout}`.trim());
  }
}

export async function killTmux(runName: string): Promise<void> {
  // Keep the private server alive after the first real cleanup so absent-session
  // assertions probe a live server; this never pre-starts the server.
  await ensureTestTmuxServer();
  await runProcess(["tmux", "kill-session", "-t", `=wux_${runName}`]);
}

type TmuxRunner = (args: string[]) => Promise<ProcessResult>;

function isStrictlyInside(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot.length > 0 && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`);
}

function allowedSocketPath(socketPath: string, allowedRoot: string, testRoot: string | undefined): boolean {
  return isStrictlyInside(socketPath, allowedRoot) || (testRoot !== undefined && isStrictlyInside(socketPath, testRoot));
}

async function realpathWithMissingTail(path: string): Promise<string> {
  const missingTail: string[] = [];
  let ancestor = resolve(path);
  for (;;) {
    try {
      return join(await realpath(ancestor), ...missingTail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missingTail.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function killPrivateTmuxServer(socketPath: string, allowedRoot: string, runner: TmuxRunner = runProcess): Promise<ProcessResult> {
  if (!isAbsolute(socketPath)) {
    throw new Error(`refusing to kill tmux server outside test-owned roots: ${socketPath}`);
  }
  const [resolvedAllowedRoot, testRoot] = await Promise.all([
    realpath(allowedRoot),
    process.env.WUX_TEST_TMUX_ROOT ? realpath(process.env.WUX_TEST_TMUX_ROOT) : undefined,
  ]);
  const resolvedSocket = join(await realpathWithMissingTail(dirname(socketPath)), basename(socketPath));
  if (!allowedSocketPath(resolvedSocket, resolvedAllowedRoot, testRoot)) {
    throw new Error(`refusing to kill tmux server outside test-owned roots: ${resolvedSocket}`);
  }
  try {
    if ((await lstat(socketPath)).isSymbolicLink()) {
      throw new Error(`refusing to kill tmux server through symlinked socket: ${socketPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { code: 0, stdout: "", stderr: "" };
    }
    throw error;
  }
  const result = await runner(["tmux", "-S", resolvedSocket, "kill-server"]);
  if (result.code !== 0) {
    throw new Error(`failed to kill private tmux server at ${resolvedSocket}: ${result.stderr || result.stdout}`.trim());
  }
  return result;
}

export async function cleanupPrivateTmuxServers(socketPaths: string[], allowedRoot: string, runner: TmuxRunner = runProcess): Promise<void> {
  const failures: Error[] = [];
  for (const socketPath of socketPaths) {
    try {
      await killPrivateTmuxServer(socketPath, allowedRoot, runner);
    } catch (error) {
      failures.push(new Error(`failed to clean private tmux socket ${socketPath}`, { cause: error }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `failed to clean ${failures.length} private tmux socket(s)`);
  }
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
