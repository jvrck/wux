# wux commands

Reference for every wux command. For install and a quickstart see the [README](../README.md); for running from source see [running.md](./running.md).

## Target Selection

Plain `wux <command>` runs locally unless a default named remote is configured.
Target selectors are mutually exclusive:

```bash
wux --local status
wux --remote worker status
wux --host ssh-worker status
```

`--local` always dispatches on this machine. `--remote <name>` resolves a named
remote from `$XDG_CONFIG_HOME/wux/config.json` or `~/.config/wux/config.json`.
`--host <host>` is the raw SSH escape hatch: it forwards the command over SSH,
resolving the remote `wux` at runtime — a `--host-wux <path>` hint first, then
`~/.local/bin/wux`, then a login-shell lookup, then a bare `wux` on the
non-interactive PATH — and passes remote stdout, stderr, and exit status through
unchanged.

Operational commands (`run`, `send`, `read`, `status`, `wait`, `result`, `mark`,
`attach`, `stop`, `interrupt`, `handoff`, `prune`, and `upgrade`) use the
configured default remote when one is set. Root `--help`, root `--version`,
`remotes` management, `mcp`, and `skills` stay local unless an explicit selector
is provided.

## Machine-readable output

`run`, `send`, `read`, `status`, `wait`, and `result` support `--json`; the
read-only `remotes` inspectors also have JSON output documented below. A local
`run`, `send`, `read`, `status`, `wait`, or `result` command invoked with
`--json` that fails writes a single error envelope to stdout and exits non-zero:

```json
{"error":{"code":"run-not-found","message":"run not found: smoke"}}
```

`message` is the same human `WuxError` text that the non-JSON path prints to
stderr. `code` is a stable machine token such as `bad-args`, `run-not-found`, or
`tmux-session-not-running`.

Frozen envelopes for the core run-inspection path:

```ts
// wux status --json
RunMeta[]

// wux run <backend> --name <name> --cwd <path> --json
{ name: string; tmuxSession: string; backend: "shell" | "claude" | "codex" }

// wux read <name> --json
{
  name: string;
  capturedAt: string;
  lines: string[];
  paneLogPath?: string;
  runDir?: string;
}

// wux result <name> --json
{
  name: string;
  outcome: "done" | "blocked" | "timeout" | "unknown";
  completedVia?: "hook" | "sentinel" | "quiescence";
  turnId?: string;                 // latest backend-signal (claude/codex)
  lastAssistantMessage?: string;   // latest backend-signal (claude/codex)
  signalAt?: string;               // latest backend-signal timestamp
  runDir: string;                  // pointer
  paneLogPath: string;             // pointer
  eventsPath: string;              // pointer (events.jsonl, full history)
  sentinelPath?: string;           // runDir/turn-complete, present only if it exists
}
```

`read --json` structures only the wrapper around a pane capture. `lines[]` is a
labelled scrape of the tmux pane; it is not structured turn output, messages, or
assistant content.

`result --json` is the backend-agnostic answer to "what did this run produce?".
It is composed read-only from existing run state, owns the schema but never the
content, and carries no git/gh/test/PR connectors — the `runDir`, `paneLogPath`,
`eventsPath`, and `sentinelPath` fields are pointers the operator follows for
out-of-band ground truth.

## Runs

```bash
wux run shell  --name smoke        --cwd "$PWD"
wux run claude --name claude-smoke --cwd "$PWD"
wux run codex  --name codex-smoke  --cwd "$PWD"
wux run shell  --name smoke-json   --cwd "$PWD" --json
```

A run creates a tmux session, metadata, an append-only pane log, and a JSONL event stream under `$XDG_STATE_HOME/wux/runs/<run-name>/` (or `~/.local/state/wux/runs/<run-name>/`). Internal tmux session names use `wux_<run-name>` because tmux treats `:` as target syntax.

All three backends share the same lifecycle, metadata, logging, send/read, attach, stop, and handoff mechanics. `shell` uses `$SHELL`; `claude` and `codex` must be available on `PATH`, and their login/approval prompts remain visible through `read` and `attach`.

`--json` prints the creation envelope `{name, tmuxSession, backend}`.

## Send

```bash
wux send smoke "printf 'hello from wux\n'"
wux send smoke --json "printf 'hello from wux\n'"
```

`send` resolves run metadata, refuses missing/stopped/dead sessions, checks ownership, sends literal text plus Enter, and appends a structured send event with byte count only. Use `--force-owner` to intentionally send to a run owned by another orchestrator.

`--json` must appear before the literal text and prints
`{name, submission, retried, bytes}`.

### Readiness gate (claude/codex)

On a busy Ink TUI a blind Enter is dropped and the typed text **strands** in the
composer. For `claude`/`codex` runs, `send` therefore **always types the literal**
(so a deliberate send-to-busy never loses bytes) but **gates the submit**: it waits
a short, bounded window for the typed text to render and the pane to be at-rest
before pressing Enter, and on a strand it re-confirms the pane left the busy state
before a single resend. The wait is hard-bounded (a small fixed number of samples,
~1s) — it rides out the post-turn redraw race, not a multi-second turn. A send into
a pane that stays genuinely busy returns an honest non-`submitted` verdict rather
than a silent strand; gate completion on `wait` plus ground truth, never on the
`send` verdict.

`shell` keeps the unconditional fast path, and any other/unknown backend falls back
to the legacy blind type+Enter. Set **`WUX_SEND_READINESS=0`** to revert every
backend to that legacy behaviour (the kill-switch; mirrors `WUX_FORCE_LOCAL` as a
single env-flag escape hatch).

The gate adds a small, bounded latency to a gated `send` on the happy path (the
readiness probe plus settles, roughly an extra half-second on an idle claude/codex
pane) — the cost of not stranding. It never grows with how long a pane stays busy.

## Read

```bash
wux read smoke --tail 50
wux read smoke --tail 50 --json
wux read --follow smoke | tee smoke.log
```

`read` captures recent output from the live tmux pane without attaching, sending input, or mutating run state. `--tail` defaults to 200 lines and must be positive.

`--json` prints `{name, capturedAt, lines, paneLogPath, runDir}`. The `lines`
array is a labelled pane scrape only.

`read --follow` is the foreground stream primitive. It tails appended bytes from
the run's `pane.log` and writes them to stdout until interrupted or until the
tmux session disappears. The stream starts at the current end of `pane.log`,
like `tail -f`, so existing scrollback is not replayed. It is still a labelled
pane scrape, not structured turn output.

Follow mode is intentionally raw: use shell pipes for filtering, saving, and
notification. It cannot be combined with `--json` or `--tail`; the
`--poll-interval-ms <ms>` option only controls the local file-tail cadence.

## Wait

```bash
wux wait smoke --idle 1s --timeout 10s
wux wait smoke --idle 1000ms --timeout 30000 --poll-interval-ms 250 --json
```

`wait` blocks in the foreground until a run settles, awaits approval, times out,
or the tmux session disappears without a completion signal. It is an operational
command and forwards to the configured default remote like `read` and `status`.

The detection ladder is fixed as `hook > sentinel > quiescence`. `claude` and
`codex` runs get a per-run backend hook that file-drops a `backend-signal` event
in the run dir; `turn-complete` reports `completedVia: "hook"` and
`awaiting-approval` reports `outcome: "blocked"` with `completedVia: "hook"`.
A `turn-complete` sentinel file is the second rung. A missing stronger signal is
unknown and falls through; `wait` never fabricates a hook or sentinel completion.
Hook and sentinel signals are accepted only for the current turn after the latest
`send` or `interrupt`, so a previous turn's file drop cannot complete a later
wait.

Quiescence is a heuristic over the captured pane frame. `wait` polls the pane,
hashes each frame, and reports done only after the hash stays unchanged for the
configured idle window. Shell runs do not receive hook injection and can only
report `completedVia: "quiescence"`.

Pane silence is not the same as process idleness. A silent-but-busy shell run
(`yes > /dev/null`, a long compute that writes only to a file) leaves the pane
byte-static, so frame-hash quiescence alone would falsely report `done` while the
process is still running. To keep shell `done` honest, once the idle window is
reached `wait` confirms — via tmux `#{pane_pid}` / `#{pane_current_command}` —
that the pane's foreground process is the shell itself (the prompt has returned).
If a foreground child is still running, `wait` keeps waiting and the run resolves
`outcome: "timeout"` rather than a false `done`. This is a single poll-based probe
per idle window — no daemon, no watcher, and no hook/sentinel rung for shell. If
the probe cannot determine state (e.g. `ps`/tmux unavailable), `wait` falls back
to the pane-quiescence verdict.

Provenance, precisely: for a shell run, `completedVia: "quiescence"` proves the
pane was byte-static for the idle window **and** the pane's foreground process was
the shell at its prompt. It does **not** prove the task succeeded — collect ground
truth from `git`, `gh`, or files. A `sleep`-style foreground child counts as
busy (a foreground process exists, so the prompt has not returned), so such runs
resolve `timeout`, not `done`.

For composed notifications and cooperative sentinel-marker practice, see
[agent-readiness.md](./agent-readiness.md).

Flags:

- `--idle <duration>`: required stable window before declaring quiescence.
  Defaults to `1s`.
- `--timeout <duration>`: maximum wait before returning `outcome: "timeout"`.
  Defaults to `30s`.
- `--poll-interval-ms <ms>`: capture interval. Defaults to `250`.
- `--json`: prints the `WaitResult` envelope.
- `--result`: with `--json`, inlines the `wux result` envelope under a `result`
  key so an autonomous loop can wait and collect in one call. The inlined
  envelope reuses `wait`'s authoritative `outcome`/`completedVia` (including
  `quiescence`, which a `result` snapshot cannot observe). Without `--result`,
  `wait`'s output shape is unchanged.

Durations accept bare milliseconds, `ms`, or `s` suffixes. Examples: `250`,
`250ms`, `1s`.

Exit codes:

- `outcome: "done"` exits 0.
- `outcome: "timeout"` exits nonzero and has no `completedVia`.
- `outcome: "blocked"` exits nonzero and reports `completedVia: "hook"`.
- `outcome: "unknown"` exits nonzero and has no `completedVia`.

`--json` prints:

```ts
{
  name: string;
  outcome: "done" | "timeout" | "blocked" | "unknown";
  completedVia?: "hook" | "sentinel" | "quiescence";
  idleMs: number;
  timeoutMs: number;
  waitedMs: number;
  pollIntervalMs: number;
}
```

## Result

```bash
wux result smoke
wux result smoke --json
wux wait smoke --idle 1s --json --result   # wait, then inline the same envelope
```

`result` is the read-path answer to "what did this run produce?". Where `wait`
answers *did it finish* and `read` returns a labelled pane scrape, `result`
composes a stable, backend-agnostic envelope **read-only** from existing run
state. It is a snapshot, not a blocker; pair it with `wait`.

It reuses `wait`'s detection probes at a single point in time: a `turn-complete`
hook signal reports `outcome: "done"` with `completedVia: "hook"`,
`awaiting-approval` reports `outcome: "blocked"`, a `turn-complete` sentinel file
reports `completedVia: "sentinel"`. Because a snapshot cannot measure quiescence
itself (that needs the idle window only `wait` polls), `result` instead **replays
the outcome `wait` last settled for the current turn**: when `wux wait` resolves a
run it records a `wait-settled` event (`outcome` + `completedVia`), and a later
`result` surfaces that same outcome. This is what lets a shell run report
`outcome: "done", completedVia: "quiescence"` from the read-only snapshot, and lets
any backend surface a `timeout`/`blocked` that `wait` recorded. Hook and sentinel
signals (claude/codex) still take precedence and are honoured only for the current
turn after the latest `send`/`interrupt`.

The replay never fabricates. A run that was never `wait`ed — and whose only ground
truth is a since-departed tmux session — still reports `outcome: "unknown"`. A
`wait-settled` record older than the latest `send`/`interrupt` belongs to a prior
turn and is treated as stale (ignored), so a fresh, still-running turn never
inherits the previous turn's outcome. `wait --result` is unaffected: it inlines
`wait`'s own live resolution, which stays byte-consistent with the standalone
`result` for the same settled turn.

`turnId`, `lastAssistantMessage`, and `signalAt` come from the latest
`backend-signal` event and are present only for `claude`/`codex` turns. Shell runs
legitimately have no assistant message or turn id, so those fields are omitted —
never fabricated.

`runDir`, `paneLogPath`, and `eventsPath` are always-present pointers;
`sentinelPath` (`runDir/turn-complete`) is present only when that file exists.
These are pointers the operator follows for out-of-band ground truth: wux owns the
*schema*, not the *content*. There are no git/gh/PR/test connectors, and `result`
does not parse worker output beyond the signal already recorded on the event.

Exit code mirrors `outcome`, consistent with `wait`:

- `outcome: "done"` exits 0.
- `outcome: "blocked"`, `"timeout"`, or `"unknown"` exits nonzero.

An unknown run (`--json`) writes the shared `{"error":{"code":"run-not-found",...}}`
envelope to stdout and exits nonzero, like `read` and `wait`.

For the canonical `drive → wait → result → branch` loop, see
[agent-readiness.md](./agent-readiness.md).

## Status and marks

```bash
wux status
wux status --json
wux mark smoke blocked
```

`status` lists known runs with `NAME`, `BACKEND`, `STATUS`, `OWNER`, and `CWD`. Live tmux sessions show `running` unless they were manually marked `waiting` or `blocked`. Missing tmux sessions show `unknown` unless the run was explicitly marked `stopped`.

`status --json` prints an array of persisted run metadata, including `name`,
`backend`, `tmuxSession`, `status`, `cwd`, `owner`, `createdAt`, and `command`.

`mark` updates run metadata and appends a structured mark event. Active marks (`waiting`, `blocked`, and `running`) require the tmux session to still exist; `stopped` can only be applied to historical run state after the session is gone.

## Attach

```bash
wux attach smoke
```

`attach` resolves the run metadata, verifies the tmux session is still live, appends an attach event, and hands the terminal to tmux. From a normal terminal it runs `tmux attach-session -t =wux_<run-name>`; from inside tmux it runs `tmux switch-client -t =wux_<run-name>` so nested tmux attach is avoided. Attach does not send input, change status, or inspect backend output.

### Scrolling back through earlier output

wux-created sessions start with a generous `history-limit` (50000 lines) so an attached human can read back through long agent turns — not just the last screen. The limit is applied **when the session's pane is created** (tmux fixes a pane's scrollback buffer at creation), via a wux-managed tmux config under `$XDG_STATE_HOME/wux/tmux.conf` (default `~/.local/state/wux/tmux.conf`). wux never edits your `~/.tmux.conf`. It briefly elevates the server's global `history-limit` only to create the first pane at the larger scrollback, then restores your prior global value; the durable limit is pinned at wux-session scope only.

To scroll back once attached, enter tmux **copy-mode** and use the usual navigation keys:

- `Ctrl-b [` — enter copy-mode (`Ctrl-b` is the default tmux prefix)
- `PageUp` / `PageDown`, arrow keys, or search (`Ctrl-b [` then `/`) — move through the scrollback
- `q` — leave copy-mode

The scroll wheel is off by default, because tmux `mouse on` changes native click-drag text selection (copying then needs Shift or Option). If you prefer wheel/drag scrolling, opt in per session by setting `WUX_TMUX_MOUSE=1` when you start the run:

```bash
WUX_TMUX_MOUSE=1 wux run shell smoke    # this session reports `mouse on`
```

`WUX_TMUX_MOUSE` is read at `wux run` time and applied only to that session. The programmatic read-path (`wux read`, `read --follow`) is unaffected by either setting.

## Stop

```bash
wux stop smoke
wux stop smoke --yes
```

`stop` resolves run metadata and is idempotent and session-agnostic: it is the one verb that tears a run down regardless of liveness. If the tmux session is still live, it asks for confirmation unless `--yes` is present, kills the session, records `status: "stopped"` plus `stoppedAt`, and appends a stop event. If the tmux session is already gone (it died, or was killed externally), `stop` finalizes the run to `stopped` and succeeds instead of erroring — no destructive action remains, so no confirmation is required on that path. A `stop` on an already-`stopped` run is a no-op success that leaves metadata and events untouched. Non-interactive callers stopping a live run must pass `--yes`. It does not delete run directories or prune logs.

## Handoff

```bash
wux handoff smoke
wux handoff smoke --prompt-file ./handoff.md --wait-ms 15000 --tail 200
wux handoff smoke --wait-ms 0   # read immediately, no settle
```

`handoff` sends a fixed prompt asking for current state, changes, blockers or approvals, files/commands/links worth preserving, and next action. `--prompt-file` sends file content instead.

After sending, `handoff` does not sleep for a fixed interval. It settles on the same completion ladder as [`wait`](#wait) — `hook > sentinel > quiescence` — and only then prints the last `--tail` lines captured from the tmux pane. This makes the worker's *completed* structured summary the common-case output instead of a half-rendered `Working` frame. `--wait-ms` is the **hard upper bound** on that settle, not a guaranteed pause: handoff returns as soon as the turn completes, or when `--wait-ms` elapses, whichever comes first. `--wait-ms 0` skips the settle and reads immediately.

Defaults are `--wait-ms 15000` and `--tail 200` (the old 1000ms default reliably captured a mid-turn pane for real `claude`/`codex` turns). `--wait-ms` must be non-negative, `--tail` must be positive, and ownership checks are the same as `send`. For turns that can run longer than `--wait-ms`, pair handoff with a follow-up [`wux wait`](#wait) to capture the final frame. The `handoff` event recorded in `events.jsonl` includes `waitOutcome`, `settledVia`, and `waitedMs` so the settle is observable after the fact.

## Skills

```bash
wux skills list
wux skills list --json
wux skills show wux > ~/.claude/skills/wux/SKILL.md
```

`skills` is a local, emit-only distribution surface for the bundled Wux companion
skills: `wux`, `dual-review`, `wux-command`, and `wux-hub`. It is not
operational and does not default-forward to a configured remote.

`skills list` prints one bundled skill name per line. `skills list --json`
prints a JSON array of those names.

`skills show <name>` prints the selected `SKILL.md` bytes verbatim to stdout.
It performs no filesystem writes and has no destination argument; the installer
or a shell redirect owns placement. Unknown skills fail with a `WuxError`-style
message on stderr and write nothing to stdout. There is deliberately no
`skills install` subcommand.

`install.sh --with-skills` places the no-script default set (`wux`,
`wux-command`, and `wux-hub`). `dual-review` is emitted by `skills show`, but its
repo-local helper script is not placed by the installer.

## Prune

```bash
wux prune --days 30 --dry-run
wux prune --days 30
wux prune --older-than 7d --dry-run
wux prune --older-than 0s --dry-run   # name every stopped run; delete nothing
```

`prune` scans run state under `$XDG_STATE_HOME/wux/runs` or `~/.local/state/wux/runs`, skips active metadata and live tmux sessions, and removes only stopped run directories older than the cutoff. `--dry-run` reports candidates without deleting them; it names each candidate run directory (the run name is the directory under `runs/`) and never lists a running run. The default retention is 30 days. Prune is explicit only; normal commands never auto-delete logs, and logs are not compressed.

### Age selection

The age cutoff has exact, exclusive semantics: a stopped run is a candidate when its **latest retention timestamp** (the max of `stoppedAt` and the `meta.json`/`pane.log`/`events.jsonl` mtimes) is **strictly older** than `now` minus the cutoff — i.e. it was "stopped more than `<cutoff>` ago". A run exactly at the boundary is kept, not pruned.

- `--older-than <duration>` accepts `ms`, `s`, `m`, `h`, or `d` suffixes; a bare number is milliseconds. For example `--older-than 30s`, `--older-than 10m`, `--older-than 2h`, `--older-than 7d`. (This is a superset of [`wux wait`](#wait)'s `ms`/`s`-only durations — `--older-than` adds `m`/`h`/`d` so a coarse age cutoff like `7d` reads naturally.)
- `--days <n>` is the day-granularity alias and is exactly equivalent to `--older-than <n>d`. Supply one of `--older-than` / `--days`, not both. `--days` keeps its long-standing positive-integer contract.
- `--older-than 0` (or `0s`) is the explicit **"select every stopped run regardless of age"** path, intended for cleaning up just-created disposable runs. It ignores the retention timestamp entirely, so a seconds-old (or even timestamp-less) stopped run is selected. Combined with `--dry-run` it names every stopped run and deletes nothing — the safe way for an operator (or agent) to assert exactly which directories a prune would remove. There is no default-aggressive behavior: `0` must be passed explicitly.

Running runs and runs with an active status (`running`, `waiting`, `blocked`) are never candidates at any cutoff, including `--older-than 0`.

## Upgrade

```bash
wux upgrade            # confirm, then download + verify + replace if newer
wux upgrade --yes      # skip the prompt (required for non-interactive use)
wux upgrade --check    # report availability only
```

`upgrade` compares the binary's CalVer version against the latest GitHub release and replaces the running binary in place. It only works on a released binary — a source/`bun run` invocation refuses. See [running.md](./running.md).

## Remotes

```bash
wux remotes list
wux remotes add worker ssh-worker --wux-path wux --cwd /tmp --default
wux remotes show worker
wux remotes default worker
wux remotes clear-default
wux remotes doctor worker
wux remotes remove worker
```

Named remotes are SSH worker targets stored in local config. They do not store
SSH keys, passwords, host-key trust, or run state. The optional `--cwd` value is
metadata used by docs, agents, and `doctor`; `wux run` still requires an
explicit `--cwd` and does not automatically inject the remote metadata.

`list` prints a table and supports `--json` for agent-readable output. `show`
prints one remote and also supports `--json`. `add` rejects duplicate names; use
`remove` and `add` to replace a remote. Remote names use letters, numbers, dot,
underscore, and dash, excluding `.` and `..`.

`doctor` is non-mutating. It checks SSH connectivity, the configured remote Wux
path, remote `wux --version`, `tmux -V`, and the configured default cwd when
present.
