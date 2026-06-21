# Agent Wux Skill Spec

This is the shared, agent-neutral operating spec for using Wux as a durable
worker-session CLI. The Codex and Claude Code skills should adapt this document
instead of inventing separate target and safety rules.

Repo skill locations:

- Codex: `.agents/skills/wux/SKILL.md`
- Claude Code: `.claude/skills/wux/SKILL.md`

For composed notifications and cooperative sentinel caveats, see
[`docs/agent-readiness.md`](./agent-readiness.md). Wux owns the stream/signal,
not the notifier or task-output ground truth.

Claude Code operator-console skills live alongside this spec:

- `/wux-command`: human-only per-run MCP controller for `open`, `send`, `read`,
  `interrupt`, `stop`, and `view`.
- `/wux-hub`: read-only MCP roster over local/configured remote runs with view
  hints and optional `remotes doctor --all --json` health.

## Target Model

Assume the named-remotes model:

- Plain `wux ...` means the user's configured default Wux target. It is local
  unless a default remote is configured.
- Run `wux remotes list` when available before choosing a remote target.
- Use `wux --local ...` when the task must run on the current machine.
- Use `wux --remote <name> ...` for a known named remote.
- Use `wux --host <ssh-host> ...` only as an explicit raw SSH escape hatch when
  the user or environment names that host.

If a local checkout predates `remotes`, `--local`, or `--remote`, say so and use
the best explicit fallback: discovered direct local binary for local-only work,
plain `wux` for the configured default target, or `--host` only for an explicit
ad hoc SSH target.

## Discovery

Before meaningful Wux work, inspect how the CLI resolves and what target state is
visible:

```bash
command -v wux
which -a wux
wux --version
wux remotes list
wux status
```

If `wux remotes list` is not supported, keep going with the rest of discovery
and report that named remotes were unavailable.

For local-only work, prefer `wux --local` when available. If it is unavailable,
choose a direct local `wux` binary discovered from `which -a wux`; do not assume
plain `wux` is local when it may be a shim or default remote.

## CWD Discipline

`--cwd` must exist on the selected execution target.

- For default-target work, validate the path on whatever target plain `wux`
  reaches.
- For forced local work, local paths are valid only with `wux --local` or a
  discovered direct local binary.
- For named remote work, use paths that exist on that remote.
- For disposable POSIX smoke checks where the target identity is unknown, `/tmp`
  is a reasonable default.

Do not pass a local workstation path to a remote/default target unless you have
confirmed that same path exists there.

## Shell Smoke Tests

Use the `shell` backend for install and wiring smoke checks. Do not launch
`claude` or `codex` backends as smoke tests.

Default-target smoke:

```bash
RUN="agent-smoke-$(date +%s)"
wux run shell --name "$RUN" --cwd /tmp
wux send "$RUN" 'printf "wux smoke: %s %s\n" "$(hostname)" "$(pwd)"'
wux read "$RUN" --tail 40
wux stop "$RUN" --yes
```

Forced-local smoke when named-local support exists:

```bash
RUN="agent-local-smoke-$(date +%s)"
wux --local run shell --name "$RUN" --cwd /tmp
wux --local send "$RUN" 'printf "local wux smoke: %s %s\n" "$(hostname)" "$(pwd)"'
wux --local read "$RUN" --tail 40
wux --local stop "$RUN" --yes
```

Named-remote smoke:

```bash
RUN="agent-remote-smoke-$(date +%s)"
wux --remote <name> run shell --name "$RUN" --cwd /tmp
wux --remote <name> send "$RUN" 'printf "remote wux smoke: %s %s\n" "$(hostname)" "$(pwd)"'
wux --remote <name> read "$RUN" --tail 40
wux --remote <name> stop "$RUN" --yes
```

If a smoke check fails after creating a run, read enough output to diagnose it,
then stop the disposable session with `stop --yes` when the session is live.

## Long-Running Sessions

For real delegated work, treat Wux runs as durable worker sessions:

1. Choose a conservative run name using letters, numbers, dot, underscore, and
   dash only.
2. Select the target deliberately: default `wux`, `wux --local`, or
   `wux --remote <name>`.
3. Verify the target `--cwd` exists before starting the run.
4. Choose `shell`, `claude`, or `codex` based on the task, not on smoke-test
   convenience.
5. Start the run, send the initial task or command, and immediately read output
   to confirm launch state.
6. Use `wait --json` when available to detect that a run settled. Treat
   `completedVia: "hook"` as a backend boundary signal for `claude`/`codex`;
   shell runs only have `completedVia: "quiescence"`, a TUI-settle heuristic.
   Hooks are injected per run, not auto-installed into backend config.
7. Use `wux read --follow` only when you need a pipeable live pane-log stream;
   it is still a labelled pane scrape, not structured task output.
8. Poll with `read` and `status`; use `mark waiting` or `mark blocked` when that
   accurately describes the worker.
9. Use `handoff` before switching context, stopping, or asking another operator
   to take over.
10. Stop disposable sessions. Do not stop a real long-running worker unless the
   user requested cleanup or the task lifecycle is clearly complete.

Example lifecycle shape:

```bash
wux --remote <name> run shell --name <run-name> --cwd <target-cwd>
wux --remote <name> send <run-name> '<command or task>'
wux --remote <name> wait <run-name> --idle 1s --timeout 30s --json
wux --remote <name> read <run-name> --tail 120
wux --remote <name> mark <run-name> waiting
wux --remote <name> handoff <run-name> --tail 200
```

## Backend Caution

The `claude` and `codex` backends create nested agent processes with their own
context, authentication state, approval behavior, and possible interactive TUI
prompts. Use them only for concrete delegated work with a clear prompt and
explicit `--cwd`.

If the first `read` shows login, approval, or other interactive state, surface
that to the user. Do not blindly send more task text into an unknown modal.

For the concrete per-backend boot/approval states (the codex directory-trust
modal, claude welcome-screen timing, the `⏵⏵ bypass permissions` / YOLO modes),
the `send` option-ordering rule (options precede text; `--` before flag-like
text), and modal recovery, follow the **Operator boot-state guide** in
[`docs/agent-readiness.md`](./agent-readiness.md#operator-boot-state-guide).
Restating its core rule: **gate on `wait` plus ground truth, not the send
verdict** — `send` only reports whether the keystroke landed
(`submitted | uncertain | not-submitted`), not whether the turn finished, and it
reliably under-claims while succeeding.

## Interactive Agent Backends

Wux drives the interactive Claude/Codex TUI. That is useful for durable placement,
normal interactive subscription sessions, and human attach/takeover. It is not a
structured turn API.

Avoid `attach` unless the user explicitly asks for interactive takeover.

For autonomous or closed-loop delegation, prefer `wux wait --json` when
available to answer whether the run settled. Do not treat `wux read` or a
quiescent `wait` result as proof that the backend completed the task. `read` is
a pane scrape, `wait` is currently a quiescence heuristic, and `handoff` settles
on the same completion ladder bounded by `--wait-ms` then scrapes the pane.
Instruct the backend to produce ground truth outside the pane:

- write a named result file;
- make a commit;
- open or update a PR;
- print a unique sentinel that can be found in `pane.log` (unique per loop,
  timeout-bound, cooperative only, and paired with ground-truth collection; see
  `docs/agent-readiness.md`);
- or leave a handoff with explicit files/commands and next state.

Collect results through the ground truth (`git`, `gh`, the result file, or
`pane.log`), not only through the fixed-height `read` frame. Do not send another
instruction into an interactive agent backend until `wait` has settled and
completion is clear from that ground truth, or a human has inspected the session.

For one-shot structured machine I/O, prefer the backend's headless mode outside
Wux when available, such as `claude -p --output-format json` or
`codex exec --json`. Use Wux when the durable session, target host placement,
subscription-authenticated interactive session, or human attach path is the point.

## Cleanup

- Always stop disposable smoke sessions with `stop --yes`.
- Leave durable workers running when persistence is the point.
- Use `handoff` before stopping a non-disposable worker.
- Use `prune --dry-run` before deleting old stopped run state.

## Reporting

Report the actual execution model you used:

- invocation form, such as `wux`, `wux --local`, `wux --remote <name>`, or
  `wux --host <ssh-host>`;
- run name, backend, cwd, and observed status;
- smoke output that identifies hostname and cwd when available;
- whether the session was stopped or intentionally left running;
- any unsupported target features or fallback decisions.

## Verification

Use these checks when editing the shared spec or agent skills:

```bash
set -euo pipefail

test -f docs/agent-wux-skill.md
test -f .agents/skills/wux/SKILL.md
test -f .claude/skills/wux/SKILL.md

grep -Eq '^name:' .agents/skills/wux/SKILL.md
grep -Eq '^description:' .agents/skills/wux/SKILL.md
grep -Eq '^name:' .claude/skills/wux/SKILL.md
grep -Eq '^description:' .claude/skills/wux/SKILL.md

grep -q 'which -a wux' docs/agent-wux-skill.md .agents/skills/wux/SKILL.md .claude/skills/wux/SKILL.md
grep -q 'wux status' docs/agent-wux-skill.md .agents/skills/wux/SKILL.md .claude/skills/wux/SKILL.md
grep -q 'wux wait' docs/agent-wux-skill.md .agents/skills/wux/SKILL.md .claude/skills/wux/SKILL.md
grep -Eqi 'configured default|default target' docs/agent-wux-skill.md .agents/skills/wux/SKILL.md .claude/skills/wux/SKILL.md
grep -Eqi 'local.*binary|direct.*binary' docs/agent-wux-skill.md .agents/skills/wux/SKILL.md .claude/skills/wux/SKILL.md
grep -Eqi 'shell.*smoke|smoke.*shell' docs/agent-wux-skill.md .agents/skills/wux/SKILL.md .claude/skills/wux/SKILL.md
grep -Eqi 'long-running|durable' docs/agent-wux-skill.md .agents/skills/wux/SKILL.md .claude/skills/wux/SKILL.md
grep -Eqi 'avoid `attach` unless.*interactive takeover' docs/agent-wux-skill.md .agents/skills/wux/SKILL.md .claude/skills/wux/SKILL.md
grep -Eqi 'out-of-band|ground truth|sentinel|pane.log' docs/agent-wux-skill.md .agents/skills/wux/SKILL.md .claude/skills/wux/SKILL.md

bun run typecheck
bun test
```
