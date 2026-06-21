import { WuxError } from "../runtime/errors";

export function notImplemented(command: string): never {
  throw new WuxError(`${command} is not implemented yet`);
}
