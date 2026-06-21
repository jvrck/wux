import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCommand } from "../../commands/run";
import { ensureFeature } from "../capability";
import { identityFor } from "../target";
import { forwardToTarget, requireExplicitTarget, resolve, toolResult, type ToolContext } from "./context";

const BACKENDS = ["shell", "claude", "codex"] as const;

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "open",
    {
      title: "open a durable session",
      description:
        "Open a new durable, human-attachable tmux session (shell/claude/codex) on a target. " +
        "Inspectable durable TUI session control — not autonomous task execution. " +
        "name and cwd are required and are never auto-generated; target is required (mutation).",
      inputSchema: {
        backend: z.enum(BACKENDS),
        name: z.string().min(1, "name is required"),
        cwd: z.string().min(1, "cwd is required"),
        target: z.string().optional(),
      },
    },
    async ({ backend, name, cwd, target }) => {
      const resolved = resolve(ctx, requireExplicitTarget(target));

      if (resolved.local) {
        const result = await runCommand({ backend, name, cwd });
        return toolResult({
          identity: identityFor(resolved, result.name, result.tmuxSession),
          name: result.name,
          backend: result.backend,
          tmuxSession: result.tmuxSession,
          cwd: result.cwd,
          runDir: result.runDir,
        });
      }

      await ensureFeature(resolved, "open", ctx.sshRunner);
      return forwardToTarget(
        ctx,
        resolved,
        ["run", backend, "--name", name, "--cwd", cwd],
        name,
      );
    },
  );
}
