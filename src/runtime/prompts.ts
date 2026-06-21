export const DEFAULT_HANDOFF_PROMPT = `Prepare a concise handoff with these sections:

current state
what changed
blockers or approvals needed
files, commands, and links worth preserving
next action

Keep it brief, concrete, and suitable for a future operator to continue the run.
`;

// Upper bound (not a fixed sleep): `handoff` settles on `wait`'s completion
// ladder bounded by this timeout, so a real claude/codex turn (several seconds)
// completes before `read`. The old 1000ms fixed sleep reliably captured a
// half-rendered `Working` frame (eval S15, 2026-06-08).
export const DEFAULT_HANDOFF_WAIT_MS = 15_000;
export const DEFAULT_HANDOFF_TAIL = 200;
