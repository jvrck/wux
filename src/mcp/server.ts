import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WuxConfig } from "../runtime/config";
import type { SshRunner } from "../transport/ssh";
import { VERSION } from "../version";
import { register as registerInterrupt } from "./tools/interrupt";
import { register as registerList } from "./tools/list";
import { register as registerOpen } from "./tools/open";
import { register as registerRead } from "./tools/read";
import { register as registerSend } from "./tools/send";
import { register as registerStop } from "./tools/stop";
import { register as registerView } from "./tools/view";
import type { ToolContext } from "./tools/context";

export interface McpServerOptions {
  config: WuxConfig;
  allowRawHost?: boolean;
  // Injectable SSH runner for remote-target forwarding (tests stub it; production
  // uses the default runProcess path inside forwardSshCommand).
  sshRunner?: SshRunner;
}

const SERVER_INSTRUCTIONS =
  "wux MCP: inspectable durable TUI session control for durable claude/codex/shell " +
  "tmux sessions (local or over SSH) that stay human-attachable. This is NOT " +
  "autonomous task execution; read is a labeled pane capture, not structured turn " +
  "output. Tools: open, list, send, read, interrupt, stop, view — call tools/list.";

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: "wux", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const ctx: ToolContext = {
    server,
    config: options.config,
    allowRawHost: options.allowRawHost,
    sshRunner: options.sshRunner,
  };

  registerOpen(server, ctx);
  registerList(server, ctx);
  registerSend(server, ctx);
  registerRead(server, ctx);
  registerInterrupt(server, ctx);
  registerStop(server, ctx);
  registerView(server, ctx);

  return server;
}
