# AGENTS.md

## Project Snapshot

`wux` is a Bun/TypeScript CLI for durable agent worker sessions backed by `tmux`.
It starts local `shell`, `claude`, and `codex` runs, records state/logs under the
user state directory, stores named remote config under the user config directory,
and can forward the same CLI contract to remote hosts over SSH. There is no
daemon. An operator-first stdio MCP control surface — `wux mcp` (local-to-client,
no daemon, no network endpoint; remotes via `--host` / `--remote`) — exposes the
operator tools (open/list/send/read/interrupt/stop/view) to MCP clients; see
docs/mcp.md. The CLI runs from source under Bun for development,
and tagged CalVer releases publish cross-compiled standalone binaries (see
[docs/releasing.md](docs/releasing.md)).

When considering changes that affect how *autonomous* agents consume wux
(structured output, completion/readiness signals, an MCP surface), keep the
deliberate ordering in mind: skills → `wux wait` + `--json` → optional MCP shim.

## Commands

```bash
bun install

# Static check (the only one; there is no linter).
bun run typecheck

# Compile a standalone binary to dist/wux (optional; releases automate this).
bun run build

# Full test suite.
bun test

# Single test file.
bun test test/send.test.ts

# Single test by name/pattern.
bun test --test-name-pattern "owner"

# Run the CLI from source; arguments after -- go to wux.
bun run wux -- --help
bun run wux -- status
bun run wux -- run shell --name smoke --cwd "$PWD"
```

`package.json` requires Bun `>=1.3.9`. `tmux` is required for real lifecycle
behavior, but many tests skip tmux-dependent assertions when `tmux` is missing.
There is no linter script.

## Architecture

The main path is:

```text
src/index.ts -> src/cli.ts -> src/commands/* -> src/runtime/*
                                      |             ^
                                      v             |
                              src/backends/*   src/transport/ssh.ts
```

- `src/index.ts` is the Bun shebang entry and only delegates to `runCli`.
- `src/cli.ts` owns the full command surface: global parsing, help text, strict
  option parsing, command dispatch, and the one error-printing boundary. If
  adding a command, update `COMMANDS`, `COMMAND_HELP`, dispatch parsing, and CLI
  tests together.
- Target selection is handled before local dispatch. `--host` forwards to a raw
  SSH host, `--remote` resolves a named remote from config, and `--local` bypasses
  a configured default remote. `src/transport/ssh.ts` strips target flags,
  shell-quotes the remaining `wux ...` command, runs `ssh <host> ...`, passes
  stdout/stderr/status through unchanged, and includes the `WUX_FORCE_LOCAL=1`
  recursion guard on forwarded commands.
- `src/commands/*.ts` are one file per verb. They compose runtime helpers and own
  user-facing command semantics: confirmation, ownership checks, dry-run output,
  status rules, and rollback behavior.
- `src/commands/remotes.ts` owns local remote config command semantics and
  diagnostics. `remotes` manages local config by default even when a default
  remote is configured; explicit `--remote`/`--host` can still forward it.
- `src/runtime/tmux.ts` is the only module that should drive `tmux`. It creates
  sessions, pipes pane logs, sends literal text, captures panes, kills sessions,
  and chooses `attach-session` vs `switch-client`.
- `src/runtime/runs.ts` owns run metadata, run-name validation, persistence,
  status marks, owner checks, and live-run guards.
- `src/runtime/state.ts` resolves state to `$XDG_STATE_HOME/wux` or
  `~/.local/state/wux`; run directories live under `runs/<name>/`.
- `src/runtime/config.ts` resolves config to `$XDG_CONFIG_HOME/wux/config.json`
  or `~/.config/wux/config.json`; runtime state never lives in config.
- `src/runtime/events.ts` appends JSONL events. `src/runtime/process.ts` wraps
  `spawn` and returns `{ code, stdout, stderr }` even for non-zero exits.
- `src/backends/*` only resolve the argv launched inside tmux. `shell` uses
  `$SHELL || /bin/sh`; `claude` and `codex` resolve executables from `PATH` and
  throw `WuxError` when absent.

Each run directory contains `meta.json`, `pane.log`, and `events.jsonl`. `RunMeta`
stores the public identity (`name`, `backend`, `cwd`, `owner`), the tmux session
name, launch command, status, and timestamps.

## Invariants

- Run names are conservative: letters, numbers, dot, underscore, and dash only;
  `.` and `..` are rejected.
- Remote names use the same conservative character set as run names. Remote host
  values must be non-empty and cannot start with `-`.
- Plain operational commands use the configured default remote only when one is
  set. `--local` and the internal `WUX_FORCE_LOCAL=1` guard force local dispatch.
  `remotes`, root help, and root version stay local unless an explicit target
  selector is used.
- A run named `foo` maps to tmux session `wux_foo`. Use exact tmux targets like
  `=wux_foo`; bare targets can prefix-match the wrong session.
- `runCommand` is transactional. If tmux creation or logging setup fails after
  state directory creation, it removes partial state and kills only the session it
  created.
- User-facing expected failures should be `WuxError`. Do not add extra catch sites
  in command handlers; let `runCli` format CLI failures as `wux: <message>`.
- Mutating a live run through `send` and `handoff` requires owner match unless
  `send --force-owner` is explicitly used. `handoff` intentionally does not force.
- `stop` is idempotent and session-agnostic: stopping a live run refuses
  non-interactive confirmation unless `--yes` is passed, then kills the session
  and persists `status: "stopped"`; stopping a run whose session is already gone
  finalizes `status: "stopped"` and succeeds (no confirmation needed, nothing
  destructive remains); a second `stop` on a `stopped` run is a no-op success.
- `mark stopped` is only valid after the tmux session is gone. Active marks
  (`running`, `waiting`, `blocked`) require a live tmux session.
- `status` derives display status from both metadata and live tmux state:
  live sessions show `running` unless explicitly `waiting`/`blocked`; absent
  non-stopped sessions show `unknown`.
- `prune` deletes only stopped run directories older than the cutoff and skips
  live tmux sessions, active statuses, invalid metadata, and missing timestamps.

## Testing Notes

Tests use Bun's test runner and live filesystem state. Follow the existing pattern
in `test/helpers.ts` for run-touching tests:

- call `hasTmux()` and return early for tmux-dependent tests when unavailable;
- isolate state by temporarily setting `process.env.XDG_STATE_HOME` to
  `tempState().stateHome`;
- restore the previous `XDG_STATE_HOME` in `finally`;
- clean up tmux sessions with `killTmux(name)` and remove temp state.

Pure behavior is tested without tmux where possible: `src/cli.ts` exposes an
`__test` bag for parser helpers, SSH forwarding accepts an injected runner, and
attach accepts an injected tmux runner.
Config-touching tests isolate config by temporarily setting
`process.env.XDG_CONFIG_HOME` to `tempConfig().configHome`.

## Review

Substantive PRs get a **dual review**: an independent Claude reviewer and an
independent Codex reviewer assess the same diff, their findings are posted as
separate per-agent PR comments, must-fix items are fixed, and the diff is
re-reviewed until both reviewers are satisfied. The two reviews are still used to
decide must-fix / nice-to-fix follow-up. It stops at the human merge gate — no
auto-merge without explicit in-session authorization. Invoke the `dual-review`
skill (`/dual-review [PR#]`). The skill exists for both agents and shares one
helper script:

Wux-first cross-agent reviewer execution is preferred when available: use an
explicit local or remote Wux target, have the cross-agent reviewer write a
report file, require a sentinel visible in `pane.log`, and stop disposable Wux
reviewer sessions after collecting the report.

- Claude: `.claude/skills/dual-review/SKILL.md`
- Codex: `.agents/skills/dual-review/SKILL.md`
- Shared mechanics: `.claude/skills/dual-review/scripts/dual-review.sh`

Both assume `claude` and `codex` are on `PATH`.

## Style

This repo uses ESM TypeScript with strict `tsconfig.json`, 2-space indentation,
LF endings, and final newlines. Use `node:` prefixes for Node builtins and
`import type` for type-only imports. Runtime logs and state belong under the user
state directory, never in the repo.

Do not add `Co-Authored-By` attribution to commits.
