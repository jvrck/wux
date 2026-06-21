// MCP target identity envelope (frozen interface, EPIC #72 §5).
//
// Present on every tool response. `runName`/`tmuxSession` are null for
// target-only or multi-run responses (use per-row identity in `list`).

export type TargetType = "local" | "remote" | "host";

export interface TargetIdentity {
  targetType: TargetType;
  targetName: string | null;
  host: string | null;
  runName: string | null;
  tmuxSession: string | null;
}
