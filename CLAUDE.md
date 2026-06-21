# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`wux` is a single-binary Bun/TypeScript CLI that wraps durable tmux sessions for agent workers (`shell`, `claude`, `codex` backends). It starts, steers (`send`), observes (`read`), attaches to, hands off, marks, stops, and prunes those sessions — locally or on a remote host over SSH. There is no daemon. An operator-first stdio MCP control surface — `wux mcp` (local-to-client, no daemon, no network endpoint; remotes via `--host` / `--remote`) — exposes the operator tools (open/list/send/read/interrupt/stop/view) to MCP clients; see [docs/mcp.md](docs/mcp.md). Every invocation is a short-lived process that shells out to `tmux`.

For changes that affect how *autonomous* agents (Claude Code, Codex) consume wux — structured `--json` output, a completion/readiness signal, or an MCP surface — keep the deliberate ordering in mind: skills → `wux wait` + `--json` → optional MCP shim.

## Commands

```bash
bun install
bun run typecheck       # tsc --noEmit (strict) — the only static check
bun test                # full suite
bun test test/send.test.ts          # single file
bun test --test-name-pattern "owner" # single test by name
bun run wux -- --help   # run the CLI from source; args after -- go to wux
bun run build           # compile a standalone dist/wux binary (optional; releases automate this)
```

For local development there is no separate compile step (and no linter): `tsc --noEmit` via `bun run typecheck` is the only static check, and the `bin` entry (`src/index.ts`) runs directly under Bun's TypeScript loader. Shipping is separate — `bun run build` emits `dist/wux`, and pushing a CalVer (`YYYY.MM.DD`) tag publishes cross-compiled release binaries that `install.sh` and `wux upgrade` consume. See [docs/releasing.md](docs/releasing.md) for the release flow and [docs/running.md](docs/running.md) for binary install and `wux upgrade`.

## Architecture

The flow is **`index.ts` → `cli.ts` (parse + dispatch) → `commands/*` (orchestrate) → `runtime/*` (effects)**. Layers below `commands/` never import from `commands/` or `cli.ts`.

- **`src/cli.ts`** — the entire argument parser and dispatcher. `parseGlobal` peels global flags (`--host`, `--host-wux`, `--remote`, `--local`, `--help`, `--version`) off the front; `dispatch` switches on the command and hand-parses each command's options with the small `take*`/`parse*` helpers. Adding or changing a command's surface happens here plus the matching `commands/` handler and the `COMMANDS` / help tables. Parsing is strict: unknown options and unexpected positionals throw.
- **`src/commands/*.ts`** — one file per verb. These compose `runtime/` helpers and own the user-facing success/failure semantics (ownership checks, confirmation prompts, dry-run, etc.).
- **`src/runtime/*.ts`** — the effectful core:
  - `state.ts` resolves the state root from `$XDG_STATE_HOME/wux` (fallback `~/.local/state/wux`); runs live under `runs/<name>/`.
  - `runs.ts` is the metadata model: `meta.json` per run, plus `createRunMeta`/`saveRun`/`loadRun`/`listRuns`/`markRun` and the `assertOwner` / `requireLiveRun` guards.
  - `tmux.ts` is the only module that drives tmux. Session lifecycle, `send-keys`, `capture-pane`, `pipe-pane` logging, and attach all live here.
  - `events.ts` appends structured JSONL to `events.jsonl`; `process.ts` is the `spawn` wrapper returning `{code, stdout, stderr}` (never rejects on non-zero exit).
  - `owner.ts` computes `user@hostname` for ownership; `errors.ts` defines `WuxError` for expected, user-facing failures.
- **`src/backends/*.ts`** — `backendCommand(backend, env)` returns the argv to launch in the tmux session. `shell` uses `$SHELL`; `claude`/`codex` resolve their executable on `PATH` via `path.ts` and throw `WuxError` if absent.
- **`src/transport/ssh.ts`** — when `--host` is present, `runCli` short-circuits *before* dispatch and forwards the stripped args as `ssh <host> wux ...`, passing remote stdout/stderr/exit-code through unchanged. Remote execution is fully delegated; nothing in `runtime/` runs locally for a `--host` call.

### Key invariants

- **tmux session naming**: a run named `foo` maps to tmux session `wux_foo` (`:` is unsafe as a tmux target). Always target sessions with the exact-match `=wux_foo` form — bare names prefix-match and will hit the wrong session.
- **`WuxError` vs other errors**: throw `WuxError` for expected, user-facing conditions (it prints as `wux: <message>` with exit 1). `runCli` is the single catch site; let unexpected errors propagate.
- **Errors over silence**: commands fail loudly rather than guessing — `stop` on an already-gone session errors instead of marking stopped; `mark stopped` is rejected while the session is live; `run` refuses a name whose directory or tmux session already exists.
- **Run creation is transactional**: `runCommand` cleans up the run directory and kills any session it created if a later step fails (see the `sessionCreated` rollback in `commands/run.ts`).
- **Ownership**: mutating commands (`send`, `handoff`) call `assertOwner`; cross-owner sends require `--force-owner`.

## Testing

Tests are colocated in `test/` and run on Bun's test runner. They exercise real `tmux` and the real filesystem, not mocks:

- Tmux-dependent tests **early-return** when `hasTmux()` is false, so they pass on machines without tmux. Don't convert these to hard failures.
- State is isolated by pointing `process.env.XDG_STATE_HOME` at a `tempState()` tmpdir inside the test and restoring it in `finally`; sessions are torn down with `killTmux`. Follow this setup/teardown pattern for any new run-touching test.
- Pure functions (arg parsing via the exported `__test` bag in `cli.ts`, `validateRunName`, ssh arg building) are tested directly without tmux.

## Conventions

- 2-space indent, LF, final newline, trimmed trailing whitespace (`.editorconfig`).
- `import type` for type-only imports; Node builtins use the `node:` prefix.
- Runtime state and raw pane logs stay under `~/.local/state/wux/` — never inside a repo.

## Review

Substantive PRs get a **dual review**: an independent Claude reviewer and an independent Codex reviewer assess the same diff, their findings are posted as separate per-agent PR comments, must-fix items are fixed, and the diff is re-reviewed until both reviewers are satisfied. The two reviews are still used to decide must-fix / nice-to-fix follow-up. Wux-first cross-agent reviewer execution is preferred when available: use an explicit local or remote Wux target, have the cross-agent reviewer write a report file, require a sentinel visible in `pane.log`, and stop disposable Wux reviewer sessions after collecting the report. It stops at the human merge gate — no auto-merge without explicit in-session authorization. Run it with the `/dual-review [PR#]` skill (`.claude/skills/dual-review/`); the Codex equivalent is `.agents/skills/dual-review/`, and both share `.claude/skills/dual-review/scripts/dual-review.sh`.
