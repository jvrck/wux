export function shellCommand(env: NodeJS.ProcessEnv = process.env, backendArgs: string[] = []): string[] {
  // shell has no wux-managed args; operator passthrough is appended verbatim.
  return [env.SHELL || "/bin/sh", ...backendArgs];
}
