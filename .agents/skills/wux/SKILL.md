---
name: wux
description: Use when operating Wux durable worker sessions, inspecting Wux targets, running Wux smoke checks, or delegating work through Wux shell, Claude, or Codex backends
---

# Wux

Use Wux as a durable tmux-backed worker-session CLI. Prefer the shared operating
spec in `docs/agent-wux-skill.md`; this file adds Codex-specific execution
rules.

For composed notifications and cooperative sentinel caveats, see
`docs/agent-readiness.md`. Wux owns the stream/signal, not the notifier or
task-output ground truth.

## Codex Workflow

1. Read or follow `docs/agent-wux-skill.md` from the Wux repo root when
   available.
2. Discover the target before meaningful work:

   ```bash
   command -v wux
   which -a wux
   wux --version
   wux remotes list
   wux status
   ```

3. Treat plain `wux` as the configured default target. Under the named-remotes
   model it is local unless a default remote is configured.
4. Use `wux --local ...` for local-only work when available. If unavailable,
   discover a direct local binary from `which -a wux` instead of assuming plain
   `wux` is local.
5. Use `wux --remote <name> ...` for a named remote from `wux remotes list`.
   Use `wux --host <ssh-host> ...` only when the user or environment explicitly
   names an ad hoc SSH target.
6. Keep `--cwd` valid on the selected target. Use `/tmp` only for disposable
   POSIX smoke checks or another path you have verified on that target.

## Smoke Checks

Use the `shell` backend for smoke checks. Do not start nested `codex` or
`claude` backends as install verification.

```bash
RUN="codex-smoke-$(date +%s)"
wux run shell --name "$RUN" --cwd /tmp
wux send "$RUN" 'printf "wux smoke: %s %s\n" "$(hostname)" "$(pwd)"'
wux read "$RUN" --tail 40
wux stop "$RUN" --yes
```

For local-only smoke, replace `wux` with `wux --local` when available or with a
discovered direct local binary. For named remote smoke, use
`wux --remote <name>` on every command.

## Durable Work

- Choose conservative run names: letters, numbers, dot, underscore, and dash.
- Pick `shell`, `claude`, or `codex` intentionally for the delegated job.
- For agent backends, send a clear prompt, use an explicit target `--cwd`, and
  read immediately to confirm the launch state.
- If a `read` shows login, approval, or modal state, report it instead of
  sending more task text.
- Avoid `attach` unless the user explicitly asks for interactive takeover.
- Remember that interactive `claude` and `codex` backends are not structured
  turn APIs. For autonomous delegation, ask the backend to signal completion via
  ground truth: write a result file, make a commit, open/update a PR, or print a
  unique sentinel that can be found in `pane.log` (unique per loop,
  timeout-bound, cooperative only, and paired with ground-truth collection; see
  `docs/agent-readiness.md`).
- Use `wux wait --json` when available to detect that a run settled. Treat
  `completedVia: "hook"` as a backend boundary signal for `claude`/`codex`;
  shell runs only have `completedVia: "quiescence"`, a TUI-settle heuristic.
  Hooks are injected per run, not auto-installed into backend config.
- Use `wux read --follow` only when you need a pipeable live pane-log stream;
  it is still a labelled pane scrape, not structured task output.
- Collect results through `git`, `gh`, result files, or `pane.log`, not only the
  fixed-height `wux read` frame. Do not send another instruction until `wait`
  has settled and that out-of-band signal is clear, or a human has inspected the
  session.
- For one-shot structured machine I/O, prefer backend headless commands outside
  Wux, such as `claude -p --output-format json` or `codex exec --json`.
- Use `read`, `status`, `mark waiting`, `mark blocked`, and `handoff` to manage
  long-running sessions.
- Stop disposable smoke sessions. Do not stop a real durable worker unless the
  user requested cleanup or the lifecycle is clearly complete.

## Reporting

Tell the user which invocation you used (`wux`, `wux --local`,
`wux --remote <name>`, `wux --host <ssh-host>`, or a discovered direct binary),
the run name, backend, cwd, observed status, and whether the session was stopped
or intentionally left running.

## Verification

```bash
test -f .agents/skills/wux/SKILL.md
grep -Eq '^name:' .agents/skills/wux/SKILL.md
grep -Eq '^description:' .agents/skills/wux/SKILL.md
grep -q 'which -a wux' .agents/skills/wux/SKILL.md
grep -q 'wux status' .agents/skills/wux/SKILL.md
grep -q 'wux wait' .agents/skills/wux/SKILL.md
grep -Eqi 'configured default|default target' .agents/skills/wux/SKILL.md
grep -Eqi 'local.*binary|direct.*binary' .agents/skills/wux/SKILL.md
grep -Eqi 'shell.*smoke|smoke.*shell' .agents/skills/wux/SKILL.md
grep -Eqi 'long-running|durable' .agents/skills/wux/SKILL.md
grep -Eqi 'avoid `attach` unless.*interactive takeover' .agents/skills/wux/SKILL.md
grep -Eqi 'out-of-band|ground truth|sentinel|pane.log' .agents/skills/wux/SKILL.md
bun run typecheck
bun test
```
