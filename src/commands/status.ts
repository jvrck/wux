import { lastInput } from "../runtime/events";
import { listRuns, type RunMeta, type RunStatus } from "../runtime/runs";
import { hasSession } from "../runtime/tmux";

export type DisplayStatus = RunStatus | "unknown";

export interface StatusRow {
  name: string;
  backend: string;
  status: DisplayStatus;
  owner: string;
  cwd: string;
  // Concurrency visibility derived from the latest mutation event (frozen §2/§3).
  lastInputBy?: string | null;
  lastInputAt?: string | null;
}

export interface StatusResult {
  rows: StatusRow[];
}

export type StatusJsonRun = RunMeta & { command: string[] };

export interface StatusJsonResult {
  runs: StatusJsonRun[];
}

export async function statusRows(): Promise<StatusRow[]> {
  const runs = await listRuns();
  const rows = await Promise.all(
    runs.map(async (run) => {
      const [live, input] = await Promise.all([hasSession(run.tmuxSession), lastInput(run.name)]);
      return {
        name: run.name,
        backend: run.backend,
        status: deriveStatus(run, live),
        owner: run.owner,
        cwd: run.cwd,
        lastInputBy: input.lastInputBy,
        lastInputAt: input.lastInputAt,
      };
    }),
  );

  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

export function deriveStatus(run: RunMeta, live: boolean): DisplayStatus {
  if (live && (run.status === "waiting" || run.status === "blocked")) return run.status;
  if (live) return "running";
  if (run.status === "stopped") return "stopped";
  return "unknown";
}

export function formatStatusRows(rows: StatusRow[]): string {
  const table = [
    ["NAME", "BACKEND", "STATUS", "OWNER", "CWD"],
    ...rows.map((row) => [row.name, row.backend, row.status, row.owner, row.cwd]),
  ];
  const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)));
  const lines = table.map((row) =>
    row
      .map((cell, column) => {
        if (column === row.length - 1) return cell;
        return cell.padEnd(widths[column]);
      })
      .join("  ")
      .trimEnd(),
  );

  return `${lines.join("\n")}\n`;
}

export async function statusCommand(): Promise<StatusResult> {
  return { rows: await statusRows() };
}

export async function statusJsonCommand(): Promise<StatusJsonResult> {
  const runs = await listRuns();
  return { runs: runs.map((run) => ({ ...run, command: run.command ?? [] })) };
}
