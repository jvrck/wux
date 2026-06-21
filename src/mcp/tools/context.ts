import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WuxConfig } from "../../runtime/config";
import { WuxError } from "../../runtime/errors";
import { bufferIO } from "../../runtime/io";
import { forwardSshCommand, type SshRunner } from "../../transport/ssh";
import { clientId } from "../client";
import type { ResolvedTarget } from "../target";
import { identityFor, resolveTarget } from "../target";

// Shared dependencies handed to every tool's register() so a tool composes
// existing command/runtime/transport code without reaching for globals.
export interface ToolContext {
  server: McpServer;
  config: WuxConfig;
  allowRawHost?: boolean;
  sshRunner?: SshRunner;
}

// A single tool result content item (text). Tools return JSON-as-text plus a
// matching structuredContent so both human-readable and machine clients work.
export interface ToolPayload {
  [key: string]: unknown;
}

// Build the standard SDK tool result from a payload object: pretty JSON text +
// structuredContent. Nothing here writes to the stdio JSON-RPC channel; results
// flow back through the SDK return value only (MCP-stdout invariant).
export function toolResult(payload: ToolPayload): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ToolPayload;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

// Resolve a tool's `target` arg against the server's config/raw-host policy.
export function resolve(ctx: ToolContext, target: string | undefined): ResolvedTarget {
  return resolveTarget(target, { config: ctx.config, allowRawHost: ctx.allowRawHost });
}

// Mutations require an explicit, non-empty target (frozen §5). Observation tools
// do not call this; they may default to local.
export function requireExplicitTarget(target: string | undefined): string {
  if (target === undefined || target.trim().length === 0) {
    throw new WuxError("a target is required for this mutation; pass target: 'local', a remote name, or a host");
  }
  return target;
}

// The MCP client id used as the `by` actor for MCP-originated mutations.
export function actorId(ctx: ToolContext): string | undefined {
  return clientId(ctx.server) ?? undefined;
}

// Map a resolved remote/host target onto the wux-resolution fields of an SSH
// forward. A raw host (#124) has no stored wuxPath, so it forwards through the
// remote runtime resolver (resolveRemoteWux + an optional WUX_REMOTE_WUX_PATH
// hint); a named remote forwards the configured wuxPath. Centralised so every
// MCP forward site (forwardToTarget, send, the capability probe) stays consistent
// and the raw-host leg can never silently regress to a bare `wux`.
export function forwardWuxResolution(
  resolved: ResolvedTarget,
): { resolveRemoteWux: true; hostWuxHint?: string } | { wuxPath: string } {
  if (resolved.resolveRemoteWux) {
    return { resolveRemoteWux: true, ...(resolved.hostWuxHint ? { hostWuxHint: resolved.hostWuxHint } : {}) };
  }
  return { wuxPath: resolved.wuxPath };
}

// Run a wux argv on a remote/host target over the hardened SSH path, returning a
// labeled result that carries the forwarded exit code + captured streams +
// identity. Used by every tool's remote branch. The local branch calls the
// command functions directly (structured results, the gated path).
//
// Attribution note: a remote mutation is executed by the remote `wux`, so its
// event `by` is the remote host's owner — the MCP client id stamps LOCAL mutations
// only. Propagating the MCP actor across SSH is a deferred enhancement (out of the
// #79 tool-surface scope; #79 surfaces lastInputBy/At rather than writing it).
export async function forwardToTarget(
  ctx: ToolContext,
  resolved: ResolvedTarget,
  argv: string[],
  runName: string | null = null,
  tmuxSession: string | null = null,
): Promise<ReturnType<typeof toolResult>> {
  const buffer = bufferIO();
  const exitCode = await forwardSshCommand({
    host: resolved.host as string,
    args: argv,
    io: buffer.io,
    ...forwardWuxResolution(resolved),
    runner: ctx.sshRunner,
  });
  return toolResult({
    forwarded: true,
    target: resolved.targetName ?? resolved.host,
    exitCode,
    stdout: buffer.stdout(),
    stderr: buffer.stderr(),
    identity: identityFor(resolved, runName, tmuxSession),
  });
}
