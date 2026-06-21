<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wux-icon-dark.svg">
    <img alt="wux" src="docs/assets/wux-icon.svg" width="120">
  </picture>
</p>

<h1 align="center">wux</h1>

<p align="center">Minimal tmux-backed worker wrapper for agent sessions.</p>

`wux` is a small CLI for starting, steering, observing, and handing off durable tmux-backed shell, Claude, and Codex sessions on local or reachable worker hosts. There is no daemon — every invocation is a short-lived process that shells out to `tmux`.

## Install

**Binary (no Bun needed).** Anonymous — no GitHub auth required:

```bash
curl -fsSL https://raw.githubusercontent.com/jvrck/wux/main/install.sh | bash
```

This installs the matching `wux-<os>-<arch>` release binary to `~/.local/bin`. For a host you'll drive with raw `--host`, that default `~/.local/bin/wux` is now resolved on the remote at runtime (or pin a non-standard path with `--host-wux`) — see [docs/running.md](docs/running.md). Installing to a directory already on the non-interactive PATH (often `/usr/local/bin`) remains the prompt-free option. `tmux` must also be present on the host.

Add `--with-skills` to opt in to companion skill placement after the binary
install:

```bash
curl -fsSL https://raw.githubusercontent.com/jvrck/wux/main/install.sh | bash -s -- --with-skills
```

The installer writes the bundled `wux`, `wux-command`, and `wux-hub` skills under
`~/.claude/skills` by invoking `wux skills show <name>`. Override the destination
with `WUX_SKILLS_DIR`. `dual-review` is still available through
`wux skills show dual-review`, but its helper script is repo-local and is not
placed by `--with-skills`.

**From source (Bun ≥ 1.3.9).**

```bash
bun install && bun link
```

**Upgrade.** `wux upgrade` self-updates a binary install to the latest release (`wux upgrade --check` just reports what's available).

## Quickstart

```bash
wux run claude --name auth-fix --cwd ~/code/myapp     # start a worker
wux send auth-fix "Work the failing tests until green. Leave a handoff."
wux read auth-fix --tail 200                           # peek at output
wux handoff auth-fix                                   # ask for a status handoff
wux stop auth-fix --yes                                # tear it down
```

State, logs, and events for each run live under `$XDG_STATE_HOME/wux/runs/<name>/` (default `~/.local/state/wux/`).

When you `wux attach`, the session keeps a generous scrollback (50000 lines) so you can read back long agent turns: enter tmux copy-mode with `Ctrl-b [`, scroll with PageUp/arrows, and leave with `q`. The scroll wheel is off by default (it changes click-drag copy); set `WUX_TMUX_MOUSE=1` on `wux run` to enable it per session. See [docs/commands.md](docs/commands.md#scrolling-back-through-earlier-output).

## Commands

| Command | What it does |
| --- | --- |
| `run <shell\|claude\|codex>` | Start a worker session |
| `send` | Send literal text plus Enter to a run |
| `read` | Read recent pane output without attaching |
| `status` | List known runs |
| `wait` | Wait until a run settles or times out |
| `result` | Print a backend-agnostic result envelope for a run |
| `mark` | Mark a run waiting / blocked / running / stopped |
| `attach` | Attach to a run's tmux session |
| `stop` | Stop a run |
| `interrupt` | Interrupt a run's current turn (sends Ctrl-C) |
| `handoff` | Send a handoff prompt and read the result |
| `prune` | Remove old stopped run state |
| `upgrade` | Self-update to the latest release |
| `remotes` | Manage named SSH worker targets |
| `mcp` | Run the stdio MCP control surface for MCP clients |
| `skills` | List or emit bundled companion skills |

`run`, `send`, `read`, `status`, `wait`, `result`, and read-only remote
inspectors support `--json` for machine-readable envelopes. `read --json` labels pane-capture
`lines[]`; it does not parse the pane body into structured turns or messages.

Full per-command reference: [docs/commands.md](docs/commands.md).

## Targets And Remote Hosts

By default, plain `wux <command>` runs locally unless you explicitly configure a
default named remote. Target selectors are:

```bash
wux --local status             # force this machine
wux --remote worker status     # use a configured remote
wux --host worker status       # ad hoc raw SSH forwarding
```

Named remotes live in `$XDG_CONFIG_HOME/wux/config.json` or
`~/.config/wux/config.json`:

```bash
wux remotes add worker ssh-worker --wux-path wux --cwd /tmp --default
wux remotes list
wux remotes doctor worker
```

`--host <host>` forwards the same command over SSH, resolving the remote `wux` at runtime — a `--host-wux` hint first, then `~/.local/bin/wux`, then a login-shell lookup, then a bare `wux` on the non-interactive PATH — and passing remote stdout, stderr, and exit status through unchanged:

```bash
wux --host worker status
wux --host worker read auth-fix --tail 200
```

`tmux` must be installed on the remote host. For raw `--host`, `wux` itself is resolved from common locations (a `--host-wux` hint, `~/.local/bin/wux`, a login-shell lookup, then the non-interactive PATH), so a `~/.local/bin` install works without a PATH change; only a named remote (with a stored `--wux-path`) or a `wux` already on the **non-interactive** SSH PATH avoids that runtime resolution — see [docs/running.md](docs/running.md).

## MCP Control Surface

`wux mcp` runs a stdio [Model Context Protocol](https://modelcontextprotocol.io)
server so an operator's client — Claude Code, the Claude/Codex desktop apps, or
Codex CLI — can open, observe, steer, interrupt, and stop durable sessions from
inside its own UI, local or across an SSH-reachable fleet. There is no daemon and
no listening port: each client spawns its own `wux mcp` child and reaches remotes
over your existing SSH. Sessions stay durable and human-attachable.

```bash
wux mcp                    # stdio MCP server (a client launches this for you)
wux mcp --allow-raw-host   # also allow raw SSH-host targets (off by default)
```

See [docs/mcp.md](docs/mcp.md) for per-surface client config, the tool reference,
targeting, and the security boundary (the client gains your SSH authority; `read`
can surface secrets into the model).

## Agent-Ready Boundary

"Agent-ready" is a precise orchestration claim, not a promise of autonomous task
completion. `wux wait` plus `completedVia` answers **did it finish?**; `wux
result` answers **what did it produce?** with a backend-agnostic envelope on the
read-path — `outcome`, `completedVia`, the worker's `lastAssistantMessage` (a
hint to branch on, never proof), and `runDir`/`paneLogPath`/`eventsPath`
pointers. The *ground-truth content* still stays out-of-band by design: wux owns
the envelope's schema, you own the truth, collected from git / gh / files / test
runs you drive yourself by following those pointers — plus a cooperative
pane-log sentinel and `read --json`. There are no git/gh/PR/test connectors.

The `completedVia` ladder (`hook` | `sentinel` | `quiescence`) never advertises
more than a backend can deliver: `claude` and `codex` emit true turn-complete
hook signals, while the `shell` backend has process-aware **quiescence** (no
completion hook) — frame-hash silence gated on a foreground-process probe that
confirms via tmux `#{pane_pid}`/`#{pane_current_command}` that the shell's prompt
has returned before declaring `done`, so a silent-but-busy run resolves `timeout`
rather than a false `done` (precise provenance in
[docs/commands.md](docs/commands.md)). Wux arbitrates hook signal > run-dir
`turn-complete` sentinel file > process-aware quiescence, with tmux session
liveness as the backstop, and reports which rung fired as `completedVia`. If the
session is gone with no completion signal, `wait` reports `unknown`, not done, and
leaves `completedVia` unset.

## Releases

Releases use CalVer (`YYYY.MM.DD`, with a `.N` suffix for same-day re-releases) and ship as standalone binaries on GitHub Releases. Pushing a date tag cross-compiles `wux-<os>-<arch>` assets (linux x64/arm64/x64-musl, darwin arm64), generates and scans a CycloneDX SBOM, and publishes `sbom.cdx.json` plus `SHA256SUMS`. `wux --version` prints the CalVer tag. See [docs/releasing.md](docs/releasing.md).

## Development

- [docs/running.md](docs/running.md) — running from source, prerequisites, the binary install, and `wux upgrade`
- [docs/building.md](docs/building.md) — compiling a standalone binary by hand
- [docs/previews.md](docs/previews.md) — branch and PR preview builds for agents and developers
- [docs/commands.md](docs/commands.md) — full command reference
- [docs/mcp.md](docs/mcp.md) — the `wux mcp` control surface: client config, tools, security

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for
development setup and conventions, and [SECURITY.md](SECURITY.md) for reporting
vulnerabilities privately.

## License

[MIT](LICENSE) © Jim Vrckovski
