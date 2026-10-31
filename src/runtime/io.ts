// Injectable IO sink (frozen interface, EPIC #72 §2).
//
// Commands write human output through a CliIO rather than `process.stdout`
// directly, so the MCP layer (#78/#79) can invoke them with an in-memory buffer
// and keep the JSON-RPC stdout channel clean. This lives below the commands layer
// so both `commands/` and the MCP server can import it without a cycle.

import { StringDecoder } from "node:string_decoder";

export interface ByteWriter {
  write(chunk: Uint8Array): unknown;
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
  const out = bufferedText();
  const err = bufferedText();
  return {
    io: {
      stdout: { write: (chunk: string | Uint8Array) => (out.write(chunk), true) },
      stderr: { write: (chunk: string | Uint8Array) => (err.write(chunk), true) },
    },
    stdout: () => out.text(),
    stderr: () => err.text(),
  };
}

function bufferedText(): { write(chunk: string | Uint8Array): void; text(): string } {
  let text = "";
  const decoder = new StringDecoder("utf8");
  return {
    write(chunk) {
      if (typeof chunk === "string") {
        text += decoder.end();
        text += chunk;
        return;
      }
      text += decoder.write(Buffer.from(chunk));
    },
    text: () => `${text}${decoder.end()}`,
  };
}
