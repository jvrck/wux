import { WuxError } from "../runtime/errors";
import { markRun, type MarkStatus as RuntimeMarkStatus } from "../runtime/runs";

export type MarkStatus = RuntimeMarkStatus;

const MARK_STATUSES = new Set<MarkStatus>(["waiting", "blocked", "running", "stopped"]);

export async function markCommand(name: string, status: MarkStatus): Promise<void> {
  if (!name) throw new WuxError("mark requires <run-name>");
  if (!MARK_STATUSES.has(status)) {
    throw new WuxError(`invalid status: ${status}`);
  }

  await markRun(name, status);
  console.log(`marked ${name} ${status}`);
}
