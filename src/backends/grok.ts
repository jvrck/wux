import { WuxError } from "../runtime/errors";
import { resolveExecutable } from "./path";
import type { BackendHookOptions } from "./claude";

// Grok 1.0.62 has no verified per-invocation hook/config injection mechanism.
// Keep this thin backend deliberately hook-free: an operator may compose an
// external hook, but wux never writes or merges ~/.grok or project config.
export async function grokCommand(
  env: NodeJS.ProcessEnv = process.env,
  _hooks: BackendHookOptions = {},
  backendArgs: string[] = [],
): Promise<string[]> {
  const executable = await resolveExecutable("grok", env);
  if (!executable) {
    throw new WuxError("grok executable not found on PATH");
  }
  return [executable, ...backendArgs];
}
