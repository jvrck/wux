// Injectable IO sink (frozen interface, EPIC #72 §2).
//
// Commands write human output through a CliIO rather than `process.stdout`
// directly, so the MCP layer (#78/#79) can invoke them with an in-memory buffer
// and keep the JSON-RPC stdout channel clean. This lives below the commands layer
// so both `commands/` and the MCP server can import it without a cycle.

export interface CliIO {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export interface BufferedIO {
  io: CliIO;
  stdout(): string;
  stderr(): string;
}

// An in-memory CliIO that captures everything written, for the MCP layer and tests.
export function bufferIO(): BufferedIO {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: { write: (chunk: string) => ((out += chunk), true) },
      stderr: { write: (chunk: string) => ((err += chunk), true) },
    },
    stdout: () => out,
    stderr: () => err,
  };
}
