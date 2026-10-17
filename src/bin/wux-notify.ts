#!/usr/bin/env bun

import { appendBackendSignal, type BackendSignal } from "../runtime/events";
import { WuxError } from "../runtime/errors";
import { loadRun } from "../runtime/runs";

type Writer = { write(chunk: string): unknown };

// appendBackendSignal resolves runDir(<run>) through the shared runtime state
// helpers, so the hook lands in the same run dir as pane.log/events.jsonl.
export interface NotifyCliOptions {
  stdin?: string;
  stderr?: Writer;
}

export async function runNotifyCli(args: string[], options: NotifyCliOptions = {}): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const runName = args[0];
  if (!runName) {
    stderr.write("wux-notify: requires <run-name>\n");
    return 1;
  }
  const parsedArgs = parseNotifyArgs(args.slice(1));
  if (parsedArgs.error) {
    stderr.write(`wux-notify: invalid signal: ${args[1]}\n`);
    return 1;
  }

  try {
    const stdinPayload = parsedArgs.payload === undefined ? parsePayload(options.stdin ?? (await readStdin())) : undefined;
    const payload = parsedArgs.payload ?? stdinPayload;
    // Preserve the helper's historical ability to receive a notification before
    // run metadata is visible (and the direct unit-test seam). Real Grok runs
    // always have metadata by the time an external hook can invoke this helper.
    const meta = await loadRun(runName).catch((error: unknown) => {
      if (error instanceof WuxError && error.message === `run not found: ${runName}`) return undefined;
      throw error;
    });
    // Path B Grok has no wux-installed lifecycle hook. Never guess from a
    // hook-shaped payload: Notification, PermissionDenied, SubagentStop and
    // unknown events are not proof that the current turn completed. A composed
    // operator hook must deliberately pass `turn-complete` or
    // `awaiting-approval` as an argument.
    if (meta?.backend === "grok" && parsedArgs.signal === undefined) {
      throw new Error("grok notifications require an explicit signal");
    }
    await appendBackendSignal(runName, {
      signal: parsedArgs.signal ?? signalFromPayload(payload) ?? "turn-complete",
      turnId: firstStringField(payload, ["turnId", "turn_id", "turn-id"]),
      lastAssistantMessage: firstStringField(payload, [
        "lastAssistantMessage",
        "last_assistant_message",
        "last-assistant-message",
        "lastAgentMessage",
        "last_agent_message",
        "last-agent-message",
      ]),
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`wux-notify: ${message}\n`);
    return 1;
  }
}

function parseNotifyArgs(args: string[]): { signal?: BackendSignal; payload?: unknown; error?: boolean } {
  const first = args[0];
  if (first === undefined) return {};
  const signal = normalizeSignal(first);
  if (signal) return { signal };
  const payload = parsePayload(first);
  if (payload !== undefined) return { payload };
  return { error: true };
}

function normalizeSignal(value: string): BackendSignal | undefined {
  if (value === "turn-complete" || value === "awaiting-approval") return value;
  return undefined;
}

function parsePayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function firstStringField(payload: unknown, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = stringField(payload, field);
    if (value !== undefined) return value;
  }
  return undefined;
}

function stringField(payload: unknown, field: string): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function signalFromPayload(payload: unknown): BackendSignal | undefined {
  const text = payloadSignalText(payload);
  if (!text) return undefined;
  const normalized = text.replaceAll(/[-\s]+/g, "_");
  if (normalized.includes("approval") || normalized.includes("permission") || normalized.includes("user_input")) {
    return "awaiting-approval";
  }
  if (
    normalized.includes("turn_complete") ||
    normalized.includes("turncomplete") ||
    normalized.includes("task_complete") ||
    normalized.includes("taskcomplete") ||
    normalized.includes("stop")
  ) {
    return "turn-complete";
  }
  return undefined;
}

function payloadSignalText(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  return [
    record.type,
    record.event,
    record.eventName,
    record.event_name,
    record["event-name"],
    record.hookEventName,
    record.hook_event_name,
    record["hook-event-name"],
    record.status,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

async function readStdin(): Promise<string> {
  if (typeof Bun !== "undefined") {
    return Bun.stdin.text();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
  process.exitCode = await runNotifyCli(process.argv.slice(2));
}
