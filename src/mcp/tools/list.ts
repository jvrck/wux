import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { statusRows } from "../../commands/status";
import { tmuxSessionName } from "../../runtime/tmux";
import { identityFor } from "../target";
import { forwardToTarget, resolve, toolResult, type ToolContext } from "./context";

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list",
    {
      title: "list runs",
      description:
        "List known durable sessions on a target with per-run status, owner, and last-input actor. " +
        "Inspectable durable TUI session control — not autonomous task execution. " +
        "Observation: target defaults to local; name filters to a single run.",
      inputSchema: {
        target: z.string().optional(),
        name: z.string().optional(),
      },
    },
    async ({ target, name }) => {
      const resolved = resolve(ctx, target);

      if (resolved.local) {
        const all = await statusRows();
        const filtered = name ? all.filter((row) => row.name === name) : all;
        const rows = filtered.map((row) => {
          const tmuxSession = tmuxSessionName(row.name);
          return {
            identity: identityFor(resolved, row.name, tmuxSession),
            name: row.name,
            backend: row.backend,
            status: row.status,
            owner: row.owner,
            cwd: row.cwd,
            lastInputBy: row.lastInputBy ?? null,
            lastInputAt: row.lastInputAt ?? null,
          };
        });
        return toolResult({ identity: identityFor(resolved), rows });
      }

      const argv = ["status"];
      return forwardToTarget(ctx, resolved, argv);
    },
  );
}
