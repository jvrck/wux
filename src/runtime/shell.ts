export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderShellCommand(args: string[]): string {
  return args.map(shellQuote).join(" ");
}
