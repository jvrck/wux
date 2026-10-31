export function hasOptionBeforeTerminator(args: string[], option: string): boolean {
  const terminatorIndex = args.indexOf("--");
  const optionArgs = terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
  return optionArgs.includes(option);
}
