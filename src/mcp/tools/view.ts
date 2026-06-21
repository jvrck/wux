import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { viewCommand } from "../../commands/view";
import { tmuxSessionName } from "../../runtime/tmux";
import { identityFor } from "../target";
import { resolve, toolResult, type ToolContext } from "./context";

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "view",
    {
      title: "how to watch a run",
      description:
        "Report how to watch a run live: its tmux target, run dir, pane.log path, and the exact attach command. " +
        "Inspectable durable TUI session control — not autonomous task execution. " +
        "Visibility only (no control, no lock). Observation: target defaults to local.",
      inputSchema: {
        name: z.string().min(1),
        target: z.string().optional(),
      },
    },
    async ({ name, target }) => {
      const resolved = resolve(ctx, target);

      if (resolved.local) {
        const result = await viewCommand({ name });
        return toolResult({
          identity: identityFor(resolved, result.name, result.tmuxSession),
          name: result.name,
          tmuxTarget: result.tmuxTarget,
          runDir: result.runDir,
          paneLogPath: result.paneLogPath,
          attachCommand: `wux attach ${result.name}`,
          lastInputBy: result.lastInputBy ?? null,
          lastInputAt: result.lastInputAt ?? null,
        });
      }

      // Remote/host: the run dir, pane.log, and last-input live on the remote host,
      // not locally — so we report only what is derivable here (the deterministic
      // tmux target) plus the exact SSH attach command, without fabricating local
      // paths or last-input values.
      const tmuxSession = tmuxSessionName(name);
      const tmuxTarget = `=${tmuxSession}:`;
      return toolResult({
        identity: identityFor(resolved, name, tmuxSession),
        name,
        tmuxTarget,
        attachCommand: `ssh -t ${resolved.host as string} tmux attach -t '${tmuxTarget}'`,
        note: "run dir, pane.log, and last-input are on the remote host; run wux read/list against this target to inspect them",
      });
    },
  );
}
