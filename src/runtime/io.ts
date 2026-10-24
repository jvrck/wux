// Injectable IO sink (frozen interface, EPIC #72 §2).
//
// Commands write human output through a CliIO rather than `process.stdout`
// directly, so the MCP layer (#78/#79) can invoke them with an in-memory buffer
// and keep the JSON-RPC stdout channel clean. This lives below the commands layer
// so both `commands/` and the MCP server can import it without a cycle.

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

function toText(chunks: Array<string | Uint8Array>): string {
  return Buffer.concat(chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk)))).toString("utf8");
}
