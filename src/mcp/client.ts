import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The connected MCP client's id, used as the `by` actor for MCP-originated
// mutations — distinct from the CLI owner "user@host". null before the initialize
// handshake or if the client sent no implementation info. A leaf module (imports
// nothing from server/tools) so the mcp layer has no import cycle.
export function clientId(server: McpServer): string | null {
  const info = server.server.getClientVersion();
  return info ? `mcp:${info.name}` : null;
}
