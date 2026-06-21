import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readCommand } from "../../commands/read";
import { tmuxSessionName } from "../../runtime/tmux";
import { identityFor } from "../target";
import { forwardToTarget, resolve, toolResult, type ToolContext } from "./context";

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "read",
    {
      title: "read a run's pane",
      description:
        "Capture the current visible pane of a run as a raw TUI scrape (ANSI/chrome possible, may be truncated). " +
        "Inspectable durable TUI session control — not autonomous task execution. " +
        "This is NOT structured turn output and carries no done-signal. Observation: target defaults to local.",
      inputSchema: {
        name: z.string().min(1),
        target: z.string().optional(),
        tail: z.number().int().positive().optional(),
      },
    },
    async ({ name, target, tail }) => {
      const resolved = resolve(ctx, target);

      if (resolved.local) {
        const result = await readCommand({ name, tail });
        return toolResult({
          identity: identityFor(resolved, result.name, tmuxSessionName(result.name)),
          name: result.name,
          label: "pane capture (raw TUI, may be truncated)",
          capturedAt: result.capturedAt,
          lines: result.lines,
          paneLogPath: result.paneLogPath,
          runDir: result.runDir,
        });
      }

      const argv = ["read", name];
      if (tail !== undefined) argv.push("--tail", String(tail));
      return forwardToTarget(ctx, resolved, argv, name, tmuxSessionName(name));
    },
  );
}
