import { capabilitiesForVersion } from "../runtime/capabilities";
import { WuxError } from "../runtime/errors";
import { runProcess, type ProcessResult } from "../runtime/process";
import { forwardTimeoutMs, sshForwardArgs, sshRawHostForwardArgs } from "../transport/ssh";
import { VERSION } from "../version";
import type { ResolvedTarget } from "./target";

export type CapabilityRunner = (args: string[]) => Promise<ProcessResult>;

export interface TargetCapabilities {
  wuxVersion: string | null;
  capabilities: string[];
  skew: boolean;
}

// Capabilities are DERIVED from the target's reported wux version (the in-wux
// version->capability table), never probed by sending feature commands. Local is
// this binary; a remote runs `wux --version` once over the hardened SSH path.
export async function targetCapabilities(
  resolved: ResolvedTarget,
  runner: CapabilityRunner = defaultRunner,
): Promise<TargetCapabilities> {
  if (resolved.local) {
    return { wuxVersion: VERSION, capabilities: capabilitiesForVersion(VERSION), skew: false };
  }
  // A raw host (#124) has no stored wuxPath, so the version probe must use the
  // same remote runtime resolver the forward does — a bare `wux --version` would
  // miss ~/.local/bin and return null, leaving the feature ungated and proceeding
  // straight into the env failure this issue fixes.
  const probeArgs = resolved.resolveRemoteWux
    ? sshRawHostForwardArgs(resolved.host as string, ["--version"], resolved.hostWuxHint)
    : sshForwardArgs(resolved.host as string, ["--version"], resolved.wuxPath);
  const result = await runner(probeArgs);
  const wuxVersion = result.code === 0 ? result.stdout.trim() || null : null;
  return {
    wuxVersion,
    capabilities: capabilitiesForVersion(wuxVersion),
    skew: wuxVersion !== null && wuxVersion !== VERSION,
  };
}

// Pure gating decision: a non-empty declared capability set must include the
// feature; an empty/unknown set (the first-cut version table) is not gated.
export function featureSupported(capabilities: string[], feature: string): boolean {
  return capabilities.length === 0 || capabilities.includes(feature);
}

// Throw a clear error if the resolved target's capabilities do not cover the
// feature. Extracted (and exported) so the rejection path is directly testable
// even while the first-cut version table is empty.
export function assertCapable(caps: TargetCapabilities, feature: string, host: string | null): void {
  if (!featureSupported(caps.capabilities, feature)) {
    throw new WuxError(`target ${host ?? "local"} (wux ${caps.wuxVersion ?? "unknown"}) does not support '${feature}'`);
  }
}

// Fail clearly BEFORE invoking a feature the target is too old to support, rather
// than hanging or surfacing a cryptic remote parse error. Local is always capable.
export async function ensureFeature(
  resolved: ResolvedTarget,
  feature: string,
  runner?: CapabilityRunner,
): Promise<void> {
  if (resolved.local) return;
  assertCapable(await targetCapabilities(resolved, runner), feature, resolved.host);
}

function defaultRunner(args: string[]): Promise<ProcessResult> {
  return runProcess(args, { timeoutMs: forwardTimeoutMs() });
}
