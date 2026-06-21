import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { interruptCommand } from "../../commands/interrupt";
import { tmuxSessionName } from "../../runtime/tmux";
import { ensureFeature } from "../capability";
import { identityFor } from "../target";
import { actorId, forwardToTarget, requireExplicitTarget, resolve, toolResult, type ToolContext } from "./context";

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "interrupt",
    {
      title: "interrupt a run",
      description:
        "Interrupt a live run's current turn with a single C-c. " +
        "Inspectable durable TUI session control — not autonomous task execution. " +
        "Ownership-checked like send; target is required (mutation).",
      inputSchema: {
        name: z.string().min(1),
        target: z.string().optional(),
        forceOwner: z.boolean().optional(),
      },
    },
    async ({ name, target, forceOwner }) => {
      const resolved = resolve(ctx, requireExplicitTarget(target));

      if (resolved.local) {
        const result = await interruptCommand({ name, forceOwner: forceOwner ?? false, actor: actorId(ctx) });
        return toolResult({
          identity: identityFor(resolved, result.name, tmuxSessionName(result.name)),
          name: result.name,
          interrupted: result.interrupted,
        });
      }

      await ensureFeature(resolved, "interrupt", ctx.sshRunner);
      const argv = ["interrupt", name];
      if (forceOwner) argv.push("--force-owner");
      return forwardToTarget(ctx, resolved, argv, name, tmuxSessionName(name));
    },
  );
}
