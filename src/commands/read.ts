import { open, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { WuxError } from "../runtime/errors";
import { loadRun as loadRunMeta, requireLiveRun } from "../runtime/runs";
import { runDir } from "../runtime/state";
import { capturePane, connectionForMeta, hasSession as hasTmuxSession } from "../runtime/tmux";

export interface ReadOptions {
  name: string;
  tail?: number;
  follow?: boolean;
  intervalMs?: number;
}

type ByteWriter = {
  write(chunk: Uint8Array): unknown;
  once?: (event: "drain" | "close" | "error", listener: () => void) => unknown;
  removeListener?: (event: "drain" | "close" | "error", listener: () => void) => unknown;
};

export interface ReadLogOptions {
  name: string;
  tail?: number;
  writer: ByteWriter;
}

type Writer = { write(chunk: string): unknown };

interface FollowRunMeta {
  name: string;
  tmuxSession: string;
  tmuxSocketPath?: string;
}

export interface FollowReadOptions {
  name: string;
  intervalMs?: number;
  writer: Writer;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  loadRun?: (name: string) => Promise<FollowRunMeta>;
  hasSession?: (session: string) => Promise<boolean>;
}

export interface FollowReadResult {
  name: string;
  interrupted: boolean;
}

export const DEFAULT_READ_FOLLOW_INTERVAL_MS = 250;

// Labeled pane capture (frozen §2). `lines` is a raw TUI scrape (ANSI/chrome
// possible, may be truncated), NOT structured turn output.
export interface ReadResult {
  name: string;
  capturedAt: string;
  lines: string[];
  paneLogPath?: string;
  runDir?: string;
}

export async function readRun(options: ReadOptions): Promise<string> {
  if (!options.name) throw new WuxError("read requires <run-name>");
  const tail = options.tail ?? 200;
  if (!Number.isSafeInteger(tail) || tail <= 0) {
    throw new WuxError("--tail must be a positive integer");
  }

  const meta = await requireLiveRun(options.name);
  return capturePane(meta.tmuxSession, tail, connectionForMeta(meta));
}

// Streams the persisted pane log rather than asking tmux for a pane scrape. This
// deliberately preserves ANSI/TUI bytes and remains available after a run stops.
export async function readLog(options: ReadLogOptions): Promise<void> {
  if (!options.name) throw new WuxError("read requires <run-name>");
  if (options.tail !== undefined && (!Number.isSafeInteger(options.tail) || options.tail <= 0)) {
    throw new WuxError("--tail must be a positive integer");
  }

  const meta = await loadRunMeta(options.name);
  const path = join(runDir(meta.name), "pane.log");
  try {
    const start = options.tail === undefined ? 0 : await tailStart(path, options.tail);
    await emitLogBytes(path, start, options.writer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WuxError(`no pane log for ${meta.name}`);
    }
    throw error;
  }
}

// Structured read result for the MCP layer. The CLI text path uses `readRun`
// directly (verbatim pane bytes), so there is no reconstruction step to drift.
export async function readCommand(options: ReadOptions): Promise<ReadResult> {
  const body = await readRun(options);
  const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
  const dir = runDir(options.name);
  return {
    name: options.name,
    capturedAt: new Date().toISOString(),
    lines: trimmed.length === 0 ? [] : trimmed.split("\n"),
    paneLogPath: join(dir, "pane.log"),
    runDir: dir,
  };
}

export async function followRead(options: FollowReadOptions): Promise<FollowReadResult> {
  if (!options.name) throw new WuxError("read requires <run-name>");
  const intervalMs = options.intervalMs ?? DEFAULT_READ_FOLLOW_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new WuxError("--poll-interval-ms must be a positive integer");
  }

  const loadRun = options.loadRun ?? loadRunMeta;
  const sleep = options.sleep ?? delay;
  const meta = await loadRun(options.name);
  const connection = connectionForMeta(meta);
  const hasSession = options.hasSession ?? ((session: string) => hasTmuxSession(session, connection));
  const paneLogPath = join(runDir(meta.name), "pane.log");
  const decoder = new StringDecoder("utf8");
  let offset = await fileSize(paneLogPath);

  try {
    while (true) {
      if (options.signal?.aborted) {
        flushDecoder(decoder, options.writer);
        return { name: meta.name, interrupted: true };
      }

      offset = await emitAppendedBytes(paneLogPath, offset, decoder, options.writer);
      if (!(await hasSession(meta.tmuxSession))) {
        offset = await emitAppendedBytes(paneLogPath, offset, decoder, options.writer);
        flushDecoder(decoder, options.writer);
        return { name: meta.name, interrupted: false };
      }

      await sleep(intervalMs, options.signal);
    }
  } catch (error) {
    flushDecoder(decoder, options.writer);
    throw error;
  }
}

async function emitAppendedBytes(path: string, offset: number, decoder: StringDecoder, writer: Writer): Promise<number> {
  const size = await fileSize(path);
  if (size <= offset) return size < offset ? size : offset;

  const handle = await open(path, "r");
  try {
    let cursor = offset;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
    while (cursor < size) {
      const length = Math.min(buffer.length, size - cursor);
      const { bytesRead } = await handle.read(buffer, 0, length, cursor);
      if (bytesRead === 0) break;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      if (text.length > 0) writer.write(text);
      cursor += bytesRead;
    }
    return cursor;
  } finally {
    await handle.close();
  }
}

async function emitLogBytes(path: string, offset: number, writer: ByteWriter): Promise<void> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    let cursor = offset;
    while (cursor < size) {
      const length = Math.min(64 * 1024, size - cursor);
      // Each output chunk owns its backing buffer: writers may retain it after
      // write() returns, so it must never be reused by a later filesystem read.
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = await readRange(handle, chunk, cursor, length);
      if (bytesRead === 0) break;
      if (writer.write(chunk.subarray(0, bytesRead)) === false && !(await waitForDrain(writer))) return;
      cursor += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

// Finds the byte offset for tail-like output without loading the full log. A
// trailing newline terminates an empty final record, so it needs one additional
// separator to retain the requested number of completed lines.
async function tailStart(path: string, lines: number): Promise<number> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return 0;

    const finalByte = Buffer.allocUnsafe(1);
    if ((await readRange(handle, finalByte, size - 1, 1)) !== 1) return 0;
    const separatorsNeeded = lines + (finalByte[0] === 0x0a ? 1 : 0);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size));
    let cursor = size;
    let separators = 0;

    while (cursor > 0) {
      const start = Math.max(0, cursor - buffer.length);
      const bytesRead = await readRange(handle, buffer, start, cursor - start);
      for (let index = bytesRead - 1; index >= 0; index -= 1) {
        if (buffer[index] !== 0x0a) continue;
        separators += 1;
        if (separators >= separatorsNeeded) return start + index + 1;
      }
      cursor = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

async function readRange(handle: FileHandle, buffer: Uint8Array, position: number, length: number): Promise<number> {
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  return bytesRead;
}

function waitForDrain(writer: ByteWriter): Promise<boolean> {
  const once = writer.once;
  if (!once) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (writable: boolean) => {
      if (settled) return;
      settled = true;
      writer.removeListener?.("drain", onDrain);
      writer.removeListener?.("close", onClose);
      writer.removeListener?.("error", onClose);
      resolve(writable);
    };
    const onDrain = () => done(true);
    const onClose = () => done(false);
    once("drain", onDrain);
    once("close", onClose);
    once("error", onClose);
  });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function flushDecoder(decoder: StringDecoder, writer: Writer): void {
  const rest = decoder.end();
  if (rest.length > 0) writer.write(rest);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
