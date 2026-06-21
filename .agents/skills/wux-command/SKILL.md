---
name: wux-command
description: Guided per-run Wux MCP controller for open, send, read, interrupt, stop, and view actions without hand-authored tool JSON
allowed-tools: Bash, Read, mcp__wux__open, mcp__wux__send, mcp__wux__read, mcp__wux__interrupt, mcp__wux__stop, mcp__wux__view
disable-model-invocation: true
---

# Wux Command

Human-only guided controller for one Wux run. Use `/wux-command <run> <verb> [args]`
to assemble Wux MCP tool calls for the operator; do not invent new CLI verbs,
MCP tools, or runtime behavior.

This skill is an operator console, not an autonomous task executor. The
`disable-model-invocation: true` frontmatter is the lock: `send`, `interrupt`,
and `stop` are human-triggered only.

## Verbs

Map each slash-command verb to the MCP tool with the same name from
`docs/mcp.md`:

- `open`: call MCP `open` with `backend`, `name`, `cwd`, and explicit `target`.
- `send`: call MCP `send` with `name`, `text`, `target`, and optional
  `forceOwner`.
- `read`: call MCP `read` with `name`, optional `target`, and optional `tail`.
- `interrupt`: call MCP `interrupt` with `name`, `target`, and optional
  `forceOwner`.
- `stop`: call MCP `stop` with `name`, `target`, and `yes:true` only after
  explicit human confirmation.
- `view`: call MCP `view` with `name` and optional `target`.

Observation tools may default to local when the MCP server supports that.
Mutation tools must carry an explicit target so the operator cannot accidentally
steer the wrong host.

## Honesty

- `send` returns `submitted`, `uncertain`, or `not-submitted`. Surface that
  `submission` verdict exactly. A non-`submitted` result is a WARNING, never a
  clean "sent" success.
- `read` is a raw, labeled pane scrape. It can be truncated by `tail`, can contain
  secrets, and has no secret redaction. Do not summarize it as structured turn
  output.
- `interrupt` and `stop` are destructive controls. Keep them human-only; `stop`
  requires explicit confirmation and `yes:true`.
- Do not fabricate a completion, done, or "needs you" signal. Use raw status,
  `wux wait`, hook/sentinel/quiescence results, or human inspection when needed.

## Reporting

Report the exact MCP tool, target, run name, and result envelope. For `view`,
surface watch hints such as tmux target, run dir, `pane.log`, and the exact
`wux attach` or SSH tmux attach command returned by the tool.

## Verification

```bash
for f in .claude/skills/wux-command/SKILL.md .agents/skills/wux-command/SKILL.md; do
  test -f "$f"
  grep -Eq '^name: wux-command' "$f"
  grep -Eq '^description:' "$f"
  grep -Eq '^allowed-tools:' "$f"
  grep -Eq '^disable-model-invocation:[[:space:]]*true' "$f"
  grep -Eq 'open|send|read|interrupt|stop|view' "$f"
  grep -Eq 'submitted|uncertain|not-submitted' "$f"
  grep -Eqi 'secret|truncat' "$f"
done
```
