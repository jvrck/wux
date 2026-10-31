// Injectable IO sink (frozen interface, EPIC #72 §2).
//
// Commands write human output through a CliIO rather than `process.stdout`
// directly, so the MCP layer (#78/#79) can invoke them with an in-memory buffer
// and keep the JSON-RPC stdout channel clean. This lives below the commands layer
// so both `commands/` and the MCP server can import it without a cycle.

export interface ByteWriter {
  write(chunk: Uint8Array): unknown;
  on?: (event: "error", listener: (error: unknown) => void) => unknown;
  once?: (event: "drain" | "close" | "error", listener: () => void) => unknown;
  removeListener?: (event: "drain" | "close" | "error", listener: () => void) => unknown;
  destroyed?: boolean;
  writableEnded?: boolean;
  closed?: boolean;
}

// A false write only means a drain event is useful when the writer supports
// event listeners. Injectable sinks without `once` have no way to signal a
// closed output, so preserve the historical best-effort streaming behavior.
export function waitForWritable(writer: ByteWriter): Promise<boolean> {
  if (writer.destroyed || writer.writableEnded || writer.closed) return Promise.resolve(false);
  if (!writer.once) return Promise.resolve(true);
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
    writer.once?.("drain", onDrain);
    writer.once?.("close", onClose);
    writer.once?.("error", onClose);
  });
}

export interface CliIO {
  stdout: { write(chunk: string | Uint8Array): unknown };
  stderr: { write(chunk: string | Uint8Array): unknown };
}

export interface BufferedIO {
  io: CliIO;
  stdout(): string;
  stderr(): string;
}

// An in-memory CliIO that captures everything written, for the MCP layer and tests.
export function bufferIO(): BufferedIO {
  const out: Array<string | Uint8Array> = [];
  const err: Array<string | Uint8Array> = [];
  return {
    io: {
      stdout: { write: (chunk: string | Uint8Array) => (out.push(chunk), true) },
      stderr: { write: (chunk: string | Uint8Array) => (err.push(chunk), true) },
    },
    stdout: () => toText(out),
    stderr: () => toText(err),
  };
}

// Decode a read-only snapshot. Keeping original strings intact preserves a
// surrogate pair split across writes; grouping adjacent byte chunks preserves a
// split UTF-8 sequence. No decoder state is mutated by stdout()/stderr().
function toText(chunks: Array<string | Uint8Array>): string {
  let text = "";
  let bytes: Uint8Array[] = [];
  const flushBytes = () => {
    if (bytes.length === 0) return;
    text += Buffer.concat(bytes.map((chunk) => Buffer.from(chunk))).toString("utf8");
    bytes = [];
  };
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      flushBytes();
      text += chunk;
    } else {
      bytes.push(chunk);
    }
  }
  flushBytes();
  return text;
}
