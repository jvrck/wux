import { hostname, userInfo } from "node:os";

export function currentOwner(): string {
  let osUser: string | undefined;
  try {
    osUser = userInfo().username;
  } catch {
    osUser = undefined;
  }
  const user = process.env.USER || process.env.LOGNAME || osUser || "unknown";
  return `${user}@${hostname()}`;
}
