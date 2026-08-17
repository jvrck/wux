import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { viewCommand } from "../../commands/view";
import { validateRunName } from "../../runtime/runs";
import { renderShellCommand } from "../../runtime/shell";
import { tmuxSessionName } from "../../runtime/tmux";
import { sshForwardArgs, sshRawHostForwardArgs } from "../../transport/ssh";
import { identityFor } from "../target";
import { resolve, toolResult, type ToolContext } from "./context";

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "view",
    {
      title: "how to watch a run",
      description:
        "Report how to watch a run live: its stable tmux target, run dir, pane.log path, and Wux attach command. " +
        "Inspectable durable TUI session control — not autonomous task execution. " +
        "Visibility only (no control, no lock). Observation: target defaults to local.",
      inputSchema: {
        name: z.string().min(1),
        target: z.string().optional(),
      },
    },
    async ({ name, target }) => {
      validateRunName(name);
      const resolved = resolve(ctx, target);

      if (resolved.local) {
        const result = await viewCommand({ name });
        return toolResult({
          identity: identityFor(resolved, result.name, result.tmuxSession),
          name: result.name,
          tmuxTarget: result.tmuxTarget,
          ...(result.tmuxSocketPath !== undefined ? { tmuxSocketPath: result.tmuxSocketPath } : {}),
          ...(result.tmuxCommand !== undefined ? { tmuxCommand: result.tmuxCommand } : {}),
          runDir: result.runDir,
          paneLogPath: result.paneLogPath,
          attachCommand: renderShellCommand([resolved.wuxPath, "--local", "attach", result.name]),
          lastInputBy: result.lastInputBy ?? null,
          lastInputAt: result.lastInputAt ?? null,
        });
      }

      // Remote/host: have the target Wux resolve its metadata when attach runs.
      // Do not invent an ambient raw tmux command here: its socket path is host-local.
      const tmuxSession = tmuxSessionName(name);
      const attachArgv = resolved.resolveRemoteWux
        ? sshRawHostForwardArgs(resolved.host as string, ["attach", name], resolved.hostWuxHint ?? "", { tty: true })
        : sshForwardArgs(resolved.host as string, ["attach", name], resolved.wuxPath, { tty: true });
      return toolResult({
        identity: identityFor(resolved, name, tmuxSession),
        name,
        tmuxTarget: `=${tmuxSession}:`,
        attachCommand: renderShellCommand(attachArgv),
        note: "run dir, pane.log, and last-input are on the remote host; run wux read/list against this target to inspect them",
      });
    },
  );
}
