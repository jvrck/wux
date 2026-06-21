import { homedir } from "node:os";
import { join } from "node:path";

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "wux");
  return join(homedir(), ".local", "state", "wux");
}

export function runsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateRoot(env), "runs");
}

export function runDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(runsRoot(env), name);
}
