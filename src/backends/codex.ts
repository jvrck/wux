import { WuxError } from "../runtime/errors";
import { resolveExecutable } from "./path";
import type { BackendHookOptions } from "./claude";

export async function codexCommand(
  env: NodeJS.ProcessEnv = process.env,
  hooks: BackendHookOptions = {},
  backendArgs: string[] = [],
): Promise<string[]> {
  const executable = await resolveExecutable("codex", env);
  if (!executable) {
    throw new WuxError("codex executable not found on PATH");
  }
  // wux-managed args (executable + notify hook) first, operator passthrough last.
  const managed = hooks.notifyCommand ? [executable, "-c", `notify=${JSON.stringify(hooks.notifyCommand)}`] : [executable];
  return [...managed, ...backendArgs];
}
