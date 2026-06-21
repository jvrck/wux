import { appendEvent } from "../runtime/events";
import { WuxError } from "../runtime/errors";
import { requireLiveRun } from "../runtime/runs";
import { attachSession, type TmuxRunner } from "../runtime/tmux";

export interface AttachOptions {
  name: string;
  env?: NodeJS.ProcessEnv;
  runner?: TmuxRunner;
}

export async function attachRun(options: AttachOptions): Promise<void> {
  if (!options.name) throw new WuxError("attach requires <run-name>");
  const meta = await requireLiveRun(options.name);
  await appendEvent(meta.name, { type: "attach" });
  await attachSession({ session: meta.tmuxSession, env: options.env, runner: options.runner });
}

export async function attachCommand(name: string): Promise<void> {
  await attachRun({ name });
}
