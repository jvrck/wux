---
name: wux-hub
description: Read-only Wux MCP roster for local and configured remote runs with view hints and optional remotes doctor health
allowed-tools: Bash, Read, mcp__wux__list, mcp__wux__view
disable-model-invocation: true
---

# Wux Hub

Read-only roster for Wux-managed runs across local and configured remote targets.
Use `/wux-hub [target]` to help the operator inspect the fleet without
hand-authoring MCP JSON. Do not frame this as mission control and do not add new
runtime behavior.

This skill is human-only via `disable-model-invocation: true`. It reads and
formats data; it does not send, interrupt, stop, or otherwise mutate runs.

## Data Source

Build the roster from the Wux MCP `list` tool, not `wux status`. The MCP `list`
tool returns structured rows and the identity envelope needed to distinguish
same-named runs across hosts:

- row fields: run, backend, raw status, owner, cwd, `lastInputBy`,
  `lastInputAt`;
- identity: `targetType`, `targetName`, `host`, `runName`, and `tmuxSession`.

For `/wux-hub` with no target, fan `list` across `local` plus each configured
remote from `wux remotes list`. For `/wux-hub <target>`, list only that target.

## Roster

Merge rows into one table with these columns:

`run | backend | status | owner | last-activity | cwd | target`

Use raw `status` and last-activity only. Last activity comes from
`lastInputAt`/`lastInputBy` when present. Never fabricate a "needs you", done,
blocked, or attention badge from heuristics.

For any selected run, call MCP `view` to show watch hints: tmux target, run dir,
`pane.log`, and the exact `wux attach` or `ssh -t ... tmux attach` command.

Optional health panel: run `wux remotes doctor --all --json` and render remote
health beside the roster. Keep health separate from run status.

## Scope Boundary

`/wux-hub` is a read-out over wux-managed runs only; it reads and formats data and
does not send, interrupt, stop, or otherwise mutate runs. Do not turn this skill
into a control plane.

## Reporting

Report the targets queried, any unreachable configured remote, the merged roster,
and whether the optional doctor panel was included. Preserve raw statuses and MCP
identity so same-named runs never collide.

## Verification

```bash
for f in .claude/skills/wux-hub/SKILL.md .agents/skills/wux-hub/SKILL.md; do
  test -f "$f"
  grep -Eq '^name: wux-hub' "$f"
  grep -Eq '^description:' "$f"
  grep -Eq '^allowed-tools:' "$f"
  grep -Eq '^disable-model-invocation:[[:space:]]*true' "$f"
  grep -Eqi 'MCP `list`|MCP list|list tool' "$f"
  grep -Fq 'run | backend | status | owner | last-activity | cwd | target' "$f"
  grep -Eqi 'doctor --all|remotes doctor' "$f"
done
```
