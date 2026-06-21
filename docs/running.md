# Running wux

## Prerequisites

- [Bun](https://bun.sh) `>=1.3.9`
- `tmux` on `PATH` (the durable session layer)
- `claude` on `PATH` for `run claude`
- `codex` on `PATH` for `run codex`

## Run from source

```bash
bun install
bun run wux -- --help
```

Arguments after `--` are passed to `wux`:

```bash
bun run wux -- status
bun run wux -- run shell --name smoke --cwd "$PWD"
```

For branch and PR preview workflows that agents can install on worker hosts
before a release, see [previews.md](./previews.md).

## Backend argument passthrough

A literal `--` in `wux run` ends wux's own options; everything after it is
forwarded verbatim to the backend, appended **after** wux's managed args (the
resolved executable and the per-run notify hook). This mirrors `cargo run -- …`
and `npm run … --`, keeping wux flags and backend flags unambiguous. wux never
interprets, validates, or allow-lists these args — it is pure passthrough.

The immediate use is launching a backend already-configured for headless /
non-interactive driving. A freshly-`run` claude session otherwise opens on the
trust-this-folder dialog, blocking a `send`-driven session that is never
attached. Skip it by passing the flag through:

```bash
wux run claude --name x --cwd "$PWD" -- --dangerously-skip-permissions
wux send x "print the current working directory"   # submits, no attach/accept
```

Codex equivalents (e.g. `-- --full-auto`) and any other backend flag
(`--model`, `--add-dir`, …) work the same way. The passthrough args are recorded
as `backendArgs` in run meta (visible in `status --json`) so the launch is
auditable and reproducible. With no `--`, behavior is unchanged.

## Backend completion hooks

`wux run` injects completion hooks per-run for the `claude` and `codex`
backends. The hook invokes the bundled `wux-notify` helper for that run, which
appends a `backend-signal` event to `events.jsonl`, updates `state.json`, and
drops a `turn-complete` sentinel file when the backend reports a turn boundary.
`wux wait` consumes those file drops before falling back to sentinel/quiescence.

This is explicit per-run injection only. `wux` does not auto-install hooks into
`~/.claude`, `~/.codex`, or any global backend config, and it does not run a
listener, daemon, or public port. The run dir is the channel.

## Install globally

```bash
bun link
wux --help
```

This puts a `wux` binary on `PATH` that runs `src/index.ts` under Bun. To compile a standalone single-file executable instead, see [building.md](./building.md).

## Install a release binary (no Bun)

For a host that just needs to run `wux` (e.g. a remote `--host` target), install a
standalone binary from a GitHub Release — anonymously, no GitHub auth required.

```bash
curl -fsSL https://raw.githubusercontent.com/jvrck/wux/main/install.sh | bash
```

The installer detects your OS/arch (glibc vs musl), downloads the matching
`wux-<os>-<arch>` asset, verifies its `SHA256SUMS` entry, and installs to
`$HOME/.local/bin/wux`. Overrides: `BIN_DIR`, `WUX_VERSION` (a CalVer tag or
`latest`), `WUX_REPO`.

Plain `install.sh` installs only the binary. To also place the bundled companion
skills for Claude Code, opt in:

```bash
curl -fsSL https://raw.githubusercontent.com/jvrck/wux/main/install.sh | bash -s -- --with-skills
```

`--with-skills` writes `wux`, `wux-command`, and `wux-hub` under
`${WUX_SKILLS_DIR:-$HOME/.claude/skills}` by invoking the installed binary as
`wux skills show <name>` and redirecting the emitted `SKILL.md` bytes.
`dual-review` is still available through `wux skills show dual-review`, but its
helper script is repo-local and is not placed by `--with-skills`. The binary
itself only emits skills; it has no `skills install` command and never writes
into harness config directories.

## Targets And Named Remotes

Plain `wux <command>` runs locally unless you explicitly configure a default
remote. Target selectors are mutually exclusive:

```bash
wux --local status             # force this machine
wux --remote worker status     # use a configured remote
wux --host ssh-worker status   # ad hoc raw SSH forwarding
```

Named remote config lives under `$XDG_CONFIG_HOME/wux/config.json` or
`~/.config/wux/config.json`; run state still lives under `$XDG_STATE_HOME/wux`.
The optional remote `--cwd` is metadata for docs, agents, and `doctor`; `run`
still requires an explicit `--cwd` on the selected target.

```bash
wux remotes add worker ssh-worker --wux-path wux --cwd /tmp
wux remotes list
wux remotes show worker
wux remotes default worker
wux remotes doctor worker
wux remotes clear-default
```

`remotes` manages local config by default even when a default remote is set.
Explicit selectors can inspect a remote host's own config if needed:

```bash
wux --remote worker remotes list
wux --host ssh-worker remotes list
```

Operational commands (`run`, `send`, `read`, `status`, `wait`, `mark`, `attach`,
`stop`, `interrupt`, `handoff`, `prune`, and `upgrade`) use the configured
default remote when no selector is present. Root `--help`, root `--version`,
local `remotes` management, `mcp`, and `skills` stay local unless an explicit
selector is used.

### Remote PATH

Named remotes run the configured `wuxPath` over SSH. Raw `--host <host>` has no
stored path, so instead of trusting a bare `wux` on the **non-interactive** SSH
PATH (which usually does **not** source `~/.bashrc`/`~/.zshrc` and often misses
`~/.local/bin`), it resolves wux on the remote at runtime, in order:

1. an explicit `--host-wux <path>` flag (or the `WUX_REMOTE_WUX_PATH` env var);
2. `$HOME/.local/bin/wux` (the default `install.sh` location);
3. a login-shell lookup (`bash -lc 'command -v wux'`);
4. a bare `wux` on the non-interactive PATH.

If none resolve, raw `--host` fails with an actionable error naming the host and
the install / `--host-wux` remedy — not a raw `env: 'wux': No such file or
directory`. For a non-standard install location:

```bash
wux --host <host> --host-wux /opt/wux/bin/wux status
# or, persisted for a shell session:
WUX_REMOTE_WUX_PATH=/opt/wux/bin/wux wux --host <host> status
```

To confirm what a non-interactive SSH sees, or to pin the path with `--host-wux`:

```bash
ssh <host> 'command -v wux'          # non-interactive PATH lookup
ssh <host> 'ls ~/.local/bin/wux'     # the default install.sh location
```

For a stable, prompt-free setup, install to a directory already on the
non-interactive PATH — often `/usr/local/bin`:

```bash
BIN_DIR=/usr/local/bin bash install.sh   # may need elevated privileges
```

A named remote (`wux remotes add <name> <host> --wux-path <path>`) records the
path once so you don't repeat `--host-wux`; `wux remotes doctor <name>` then
verifies it.

Use `wux remotes doctor <name>` after adding a named remote. It checks SSH,
remote `wux --version`, `tmux -V`, `claude`/`codex` presence (advisory), version
skew vs the local wux, and the configured default cwd when present — reporting all
checks rather than stopping at the first failure.

## Fleet over Tailscale

To drive a fleet (e.g. a Mac mini plus Linux servers and VMs) as one set of wux
targets, give each host a stable name over a private network such as
[Tailscale](https://tailscale.com), then register each as a named remote:

1. **Install per host.** Put `wux` + `tmux` on each host's **non-interactive** SSH
   PATH (see [Remote PATH](#remote-path) above), and add your SSH key so
   `ssh <host>` is non-interactive (no password/host-key prompt — wux uses
   `BatchMode=yes`, so a prompt fails fast rather than hanging).
2. **Add each host** with its Tailscale name (or `ssh_config` alias):

   ```bash
   wux remotes add mini   mini.tailnet.ts.net   --cwd /Users/you/code
   wux remotes add linux1 linux1.tailnet.ts.net --cwd /srv/work
   ```

3. **Check fleet readiness in one call.** `wux remotes doctor --all` runs the
   readiness report across **every configured remote plus the local host** (local
   first); one unreachable host never aborts the rest. Add `--json` for a
   machine-readable report (an array of per-host `DoctorReport`s) for dashboards or
   the MCP layer:

   ```bash
   wux remotes doctor --all          # human-readable, all hosts incl. local
   wux remotes doctor --all --json   # array of per-host reports incl. local
   ```

   There is no separate local-only flag — `--all` always includes the local host
   (`local`/`localhost` are reserved remote names). It exits non-zero if any host
   fails a *critical* check (ssh / wux / tmux); `claude`/`codex`/cwd/version-skew
   are advisory and never fail a host.

Once a fleet is healthy, drive any host with `--remote <name>` from the CLI, or
target it by name from an MCP client — see [mcp.md](./mcp.md).

## Upgrade

A binary install updates itself in place:

```bash
wux upgrade           # confirm, then download + verify + replace if newer
wux upgrade --yes     # skip the prompt (required for non-interactive use)
wux upgrade --check   # report availability only, change nothing
```

`upgrade` compares the binary's CalVer version against the latest release and is
a no-op when already current. It prompts before replacing the binary unless
`--yes` is given (and refuses without `--yes` when stdin is not a TTY). It only
works on a released binary — a source/`bun run` invocation (version `0.0.0-dev`,
or any host whose executable is `bun`/`node`) refuses, since it cannot replace
itself.

## Example commands

```bash
wux run shell --name smoke --cwd "$PWD"
wux send smoke "printf 'hello from wux\n'"
wux read smoke --tail 50
wux stop smoke --yes
```

For driving wux from an MCP client (Claude Code, Claude/Codex desktop, Codex
CLI), see [mcp.md](./mcp.md).
