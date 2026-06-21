import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

export async function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<string | undefined> {
  const path = env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    const searchDir = dir.length === 0 ? "." : dir;
    const candidate = resolve(cwd, searchDir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH.
    }
  }
  return undefined;
}
