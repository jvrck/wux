import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpServer } from "../mcp/server";
import { loadConfig } from "../runtime/config";
import type { SshRunner } from "../transport/ssh";

export interface McpOptions {
  allowRawHost?: boolean;
  // Injectable transport for tests; production uses stdio.
  transport?: Transport;
  // Injectable SSH runner for remote-target forwarding (tests stub it).
  sshRunner?: SshRunner;
}

// Run the wux MCP server over stdio (no daemon, no listening port). Long-lived:
// resolves when the client disconnects. stdio IS the JSON-RPC channel, so nothing
// here may write to process.stdout.
export async function mcpCommand(options: McpOptions = {}): Promise<void> {
  const config = await loadConfig();
  const server = createMcpServer({ config, allowRawHost: options.allowRawHost, sshRunner: options.sshRunner });
  const transport = options.transport ?? new StdioServerTransport();

  // Install the close handler BEFORE connect so an immediate disconnect during
  // startup is not missed. The SDK's StdioServerTransport does not observe stdin
  // EOF, so for the real stdio path we also resolve on stdin end/close — otherwise
  // a client that closes the pipe would leave `wux mcp` hung.
  const closed = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.server.onclose = finish;
    if (!options.transport) {
      process.stdin.once("end", finish);
      process.stdin.once("close", finish);
    }
  });

  await server.connect(transport);
  await closed;
  await server.close().catch(() => undefined);
}
