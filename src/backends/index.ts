import type { RunBackend } from "../runtime/runs";
import { claudeCommand, type BackendHookOptions } from "./claude";
import { codexCommand } from "./codex";
import { shellCommand } from "./shell";

export async function backendCommand(
  backend: RunBackend,
  env: NodeJS.ProcessEnv = process.env,
  hooks: BackendHookOptions = {},
  backendArgs: string[] = [],
): Promise<string[]> {
  switch (backend) {
    case "shell":
      return shellCommand(env, backendArgs);
    case "claude":
      return claudeCommand(env, hooks, backendArgs);
    case "codex":
      return codexCommand(env, hooks, backendArgs);
  }
}
