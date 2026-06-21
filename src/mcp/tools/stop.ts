import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stopCommand } from "../../commands/stop";
import { WuxError } from "../../runtime/errors";
import { tmuxSessionName } from "../../runtime/tmux";
import { ensureFeature } from "../capability";
import { identityFor } from "../target";
import { actorId, forwardToTarget, requireExplicitTarget, resolve, toolResult, type ToolContext } from "./context";

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "stop",
    {
      title: "stop a run",
      description:
        "Stop a run, killing its tmux session. Destructive: requires an explicit yes:true confirmation. " +
        "Inspectable durable TUI session control — not autonomous task execution. target is required (mutation).",
      inputSchema: {
        name: z.string().min(1),
        target: z.string().optional(),
        yes: z.literal(true).describe("must be true to confirm this destructive stop"),
      },
    },
    async ({ name, target, yes }) => {
      const resolved = resolve(ctx, requireExplicitTarget(target));
      if (yes !== true) throw new WuxError("stop is destructive; pass yes: true to confirm");

      if (resolved.local) {
        const result = await stopCommand(name, true, actorId(ctx));
        return toolResult({
          identity: identityFor(resolved, result.name, tmuxSessionName(result.name)),
          name: result.name,
          stopped: result.stopped,
        });
      }

      await ensureFeature(resolved, "stop", ctx.sshRunner);
      return forwardToTarget(ctx, resolved, ["stop", name, "--yes"], name, tmuxSessionName(name));
    },
  );
}
