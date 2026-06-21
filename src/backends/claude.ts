import { WuxError } from "../runtime/errors";
import { resolveExecutable } from "./path";

export interface BackendHookOptions {
  notifyCommand?: string[];
}

export async function claudeCommand(
  env: NodeJS.ProcessEnv = process.env,
  hooks: BackendHookOptions = {},
  backendArgs: string[] = [],
): Promise<string[]> {
  const executable = await resolveExecutable("claude", env);
  if (!executable) {
    throw new WuxError("claude executable not found on PATH");
  }
  // wux-managed args (executable + notify hook) first, operator passthrough last.
  const managed = hooks.notifyCommand
    ? [executable, "--settings", JSON.stringify(claudeHookSettings(hooks.notifyCommand))]
    : [executable];
  return [...managed, ...backendArgs];
}

function claudeHookSettings(notifyCommand: string[]): unknown {
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: notifyCommand.map(shellQuote).join(" "),
            },
          ],
        },
      ],
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
