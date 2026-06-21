import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendCommand, type SendResult } from "../../commands/send";
import { bufferIO } from "../../runtime/io";
import { tmuxSessionName } from "../../runtime/tmux";
import { forwardSshCommand } from "../../transport/ssh";
import { ensureFeature } from "../capability";
import { identityFor } from "../target";
import type { ResolvedTarget } from "../target";
import { actorId, forwardWuxResolution, requireExplicitTarget, resolve, toolResult, type ToolContext } from "./context";

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "send",
    {
      title: "send text to a run",
      description:
        "Send literal text plus Enter to a live run and report whether the backend accepted the submit. " +
        "Inspectable durable TUI session control — not autonomous task execution. " +
        "The submission verdict is a heuristic over the pane, not an end-of-turn signal; " +
        "a non-submitted verdict is a warning, never a clean success. target is required (mutation).",
      inputSchema: {
        name: z.string().min(1),
        text: z.string(),
        // Optional in the schema so a missing target hits the runtime check below
        // with a clear, actionable message; the description marks it required.
        target: z.string().optional(),
        forceOwner: z.boolean().optional(),
      },
    },
    async ({ name, text, target, forceOwner }) => {
      const resolved = resolve(ctx, requireExplicitTarget(target));

      if (resolved.local) {
        const result = await sendCommand({ name, text, forceOwner: forceOwner ?? false, actor: actorId(ctx) });
        return toolResult(sendPayload(resolved, result));
      }

      // Remote: forward with --json so the verdict stays structured (parity with the
      // local path), falling back to a labeled passthrough if the output isn't parseable.
      await ensureFeature(resolved, "send", ctx.sshRunner);
      const argv = ["send", name, "--json"];
      if (forceOwner) argv.push("--force-owner");
      argv.push("--", text);
      const buffer = bufferIO();
      const exitCode = await forwardSshCommand({
        host: resolved.host as string,
        args: argv,
        io: buffer.io,
        ...forwardWuxResolution(resolved),
        runner: ctx.sshRunner,
      });
      const parsed = parseSendResult(buffer.stdout());
      if (parsed) return toolResult(sendPayload(resolved, parsed));
      return toolResult({
        forwarded: true,
        exitCode,
        stdout: buffer.stdout(),
        stderr: buffer.stderr(),
        identity: identityFor(resolved, name, tmuxSessionName(name)),
      });
    },
  );
}

function parseSendResult(stdout: string): SendResult | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const value = JSON.parse(trimmed) as Partial<SendResult>;
    if (
      typeof value.name === "string" &&
      typeof value.submission === "string" &&
      typeof value.retried === "boolean" &&
      typeof value.bytes === "number"
    ) {
      return value as SendResult;
    }
  } catch {
    // Not JSON (e.g. an older remote wux without --json) — fall back to passthrough.
  }
  return null;
}

// Shape a SendResult into the tool payload. The submission verdict is always
// surfaced; a non-submitted verdict adds an explicit `warning` so a client never
// mistakes it for a clean success. Exported for unit-testing the shaping.
export function sendPayload(resolved: ResolvedTarget, result: SendResult): Record<string, unknown> {
  const submitted = result.submission === "submitted";
  const payload: Record<string, unknown> = {
    identity: identityFor(resolved, result.name, tmuxSessionName(result.name)),
    name: result.name,
    bytes: result.bytes,
    submission: result.submission,
    retried: result.retried,
    submitted,
  };
  if (!submitted) {
    payload.warning = `${result.name} may not have submitted (${result.submission}${result.retried ? ", retried" : ""}); this is not a clean success`;
  }
  return payload;
}
