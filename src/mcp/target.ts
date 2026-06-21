import { remoteWuxHintFromEnv, remoteWuxPath, type WuxConfig } from "../runtime/config";
import { WuxError } from "../runtime/errors";
import type { TargetIdentity, TargetType } from "./identity";

export interface ResolvedTarget {
  targetType: TargetType;
  targetName: string | null;
  host: string | null; // ssh host for remote/host; null for local
  wuxPath: string; // remote wux path; "wux" for a raw host
  local: boolean;
  // Raw `--host` targets (targetType === "host") have no stored wuxPath, so a bare
  // `wux` over non-interactive SSH misses common installs like `~/.local/bin`
  // (#124). These steer every forward (forwardToTarget/send/the capability probe)
  // onto the remote runtime resolver instead. Named remotes leave both unset.
  resolveRemoteWux?: boolean;
  hostWuxHint?: string;
}

export interface ResolveTargetOptions {
  config: WuxConfig;
  allowRawHost?: boolean;
}

const LOCAL_NAMES = new Set(["local", "localhost"]);

// Map a tool's `target` argument to a concrete target. Observation may default to
// local (target omitted); mutations pass an explicit target (enforced by #79).
// Configured remotes are preferred; a raw host is opt-in (allowRawHost).
export function resolveTarget(target: string | undefined, options: ResolveTargetOptions): ResolvedTarget {
  if (target === undefined || target.length === 0 || LOCAL_NAMES.has(target.toLowerCase())) {
    return { targetType: "local", targetName: null, host: null, wuxPath: "wux", local: true };
  }

  const remote = options.config.remotes[target];
  if (remote) {
    return {
      targetType: "remote",
      targetName: target,
      host: remote.host,
      wuxPath: remoteWuxPath(remote),
      local: false,
    };
  }

  if (options.allowRawHost) {
    // Reject option-like (leading "-") and any whitespace so a raw target can never
    // become a malformed or injected SSH host argument. (Hyphens within a hostname
    // are fine; only a leading "-" is rejected.)
    if (target.startsWith("-") || /\s/.test(target)) {
      throw new WuxError(`invalid raw host: ${target}`);
    }
    // A raw host resolves wux on the remote at runtime (parity with the CLI raw
    // `--host` path), so wuxPath is unused; the optional hint comes from
    // WUX_REMOTE_WUX_PATH (there is no per-call --host-wux flag on the MCP surface).
    const hostWuxHint = remoteWuxHintFromEnv();
    return {
      targetType: "host",
      targetName: null,
      host: target,
      wuxPath: "wux",
      local: false,
      resolveRemoteWux: true,
      ...(hostWuxHint ? { hostWuxHint } : {}),
    };
  }

  throw new WuxError(
    `unknown target '${target}'; add it with 'wux remotes add', or enable raw hosts (allowRawHost)`,
  );
}

// Build the §5 identity envelope for a resolved target. runName/tmuxSession are
// null until a tool resolves a specific run.
export function identityFor(
  resolved: ResolvedTarget,
  runName: string | null = null,
  tmuxSession: string | null = null,
): TargetIdentity {
  return {
    targetType: resolved.targetType,
    targetName: resolved.targetName,
    host: resolved.host,
    runName,
    tmuxSession,
  };
}
