# wux MCP control surface

`wux mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server
over **stdio** so an operator's MCP client — Claude Code, the Claude desktop app,
Codex CLI, or the Codex desktop app — can open, observe, steer, interrupt, and stop
durable `claude`/`codex`/`shell` tmux sessions from inside its own UI, local or
across an SSH-reachable fleet.

It is **stdio + local to the client**: each client spawns its own `wux mcp` child
process and talks to it over stdin/stdout. There is **no daemon, no listening port,
and no network-exposed endpoint** — remote sessions are reached through the
operator's existing SSH (`--host` / configured `--remote`), not by exposing wux on
the network. The sessions stay durable and human-attachable (`wux attach`) exactly
as with the CLI.

This is an **operator-in-the-loop** surface: a human reads relayed panes and
decides. It is deliberately *not* an autonomous task executor — `read` is a labeled
pane capture (raw TUI, possibly truncated), not structured turn output, and `send`
reports an honest submission heuristic, never a completion signal.

## Tools

Every tool returns an **identity envelope** `{targetType, targetName, host,
runName, tmuxSession}` so a client can never confuse runs that share a name across
hosts. **Mutations** (`open`/`send`/`interrupt`/`stop`) require an explicit
`target`; **observation** (`list`/`read`/`view`) defaults to `local`.

| Tool | Kind | Args | What it does |
| --- | --- | --- | --- |
| `open` | mutation | `backend`, `name`, `cwd`, `target` | Open a durable session (`run`). `name`/`cwd` required. |
| `list` | observation | `target?`, `name?` | List runs with status, owner, and `lastInputBy`/`lastInputAt`. |
| `send` | mutation | `name`, `text`, `target`, `forceOwner?` | Send text + Enter; returns an honest `submission` verdict (`submitted`/`uncertain`/`not-submitted`) — a non-`submitted` result is a **warning**, never a clean success. |
| `read` | observation | `name`, `target?`, `tail?` | Return a **labeled pane capture** (raw TUI, may be truncated); for a local target it also includes `pane.log` / run-dir paths. |
| `interrupt` | mutation | `name`, `target`, `forceOwner?` | Send a single `C-c` to a run's current turn. |
| `stop` | mutation | `name`, `target`, `yes:true` | Stop a run (destructive; requires `yes:true`). |
| `view` | observation | `name`, `target?` | How to watch live: tmux target, run dir, `pane.log`, and the exact `wux attach` / `ssh -t … tmux attach` command. |

Tool and server descriptions frame wux as *inspectable durable TUI session
control*, not autonomous task execution.

CLI `read --follow` is deliberately not exposed as an MCP stream in this slice;
the MCP `read` tool remains a single-shot observation.

## Targeting

- **`local`** (or omit, for observation) — this machine.
- **A configured remote name** — e.g. `target: "worker"` after `wux remotes add worker …`. Preferred for fleets; capabilities and reachability are derived from the remote's wux version (see fleet setup in [running.md](./running.md)).
- **A raw SSH host** — opt-in only: start the server with `wux mcp --allow-raw-host`, then pass `target: "some-host"`. Off by default so a client can't reach arbitrary hosts.

`local`/`localhost` are reserved names (they always mean this machine).

## Client configuration

All four surfaces launch the same command: `wux` with args `["mcp"]`. Each snippet
below adds a server named `wux`.

> **PATH for GUI-launched apps.** Desktop apps (Claude desktop, Codex desktop) do
> **not** inherit your shell `PATH`, so `wux` on its own often won't resolve. Use an
> **absolute path** to the binary (e.g. `/Users/you/.local/bin/wux` — find it with
> `which wux`) in `command`, or ensure the binary is on the app's environment PATH.

> **Verification.** On **2026-06-07** the operator loop
> (`open` → `send` → `read` → `stop`, plus `list`/`view`) was driven end-to-end
> against a compiled `wux mcp` over the real MCP stdio protocol with an MCP client
> (verified with **Claude Code 2.1.168** and **Codex CLI 0.137.0**): `tools/list`
> returns the seven tools, `send` reported a `submitted` verdict, `read` returned
> the labeled pane capture containing the sent marker, and `list` showed the
> client id stamped as `lastInputBy`. (`interrupt` is covered by the test suite.)
> The CLI config snippets below match those versions.
>
> The **Claude desktop app 1.11187.4** was verified on **2026-06-08** by driving
> the operator loop (`open` → `list` → `send` → `read` → `stop`, plus final
> `list`) end-to-end using `wux 2026.06.08` against the configured Tailscale remote
> `worker` over the operator's SSH agent: `tools/list` returned the seven Wux
> tools, `open` started a durable remote shell run, `list` showed status/owner
> metadata, `send` reported `submitted`, `read` returned the labeled pane capture
> with the marker, and `stop` tore the tmux session down. This verifies the
> Claude desktop recipe when the operator machine is on the same network as the
> remote with a working SSH agent. **Mobile is watch-only** because it cannot
> spawn a local `wux mcp` child or use the operator's SSH agent; no mobile
> verification is claimed.

### Claude Code

Project-scoped `.mcp.json` (or `~/.claude.json` for user scope), or run
`claude mcp add wux -- wux mcp`:

```json
{
  "mcpServers": {
    "wux": { "command": "wux", "args": ["mcp"] }
  }
}
```

### Claude desktop  (verified — Claude desktop app 1.11187.4, 2026-06-08)

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "wux": { "command": "/Users/you/.local/bin/wux", "args": ["mcp"] }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.wux]
command = "wux"
args = ["mcp"]
```

### Codex desktop  (unverified — confirm format for your version)

The Codex desktop app reads the same `~/.codex/config.toml`, so add the server
there (use an absolute `command` path, per the PATH note above):

```toml
[mcp_servers.wux]
command = "/Users/you/.local/bin/wux"
args = ["mcp"]
```

## SECURITY

Read this before pointing a desktop app at `wux mcp`.

- **The MCP server runs with your local privileges and your SSH authority.** A
  client driving `wux mcp` can open, steer, and **stop** sessions on **any
  configured remote** — the app effectively gains your SSH reach to those hosts.
  Only configure remotes you intend the client to control, and only enable
  `--allow-raw-host` when you specifically want arbitrary-host targeting.
- **`read` can surface secrets into the model's context.** It returns raw pane
  text verbatim — anything visible in a session (tokens, keys, `.env` echoes,
  command output) is sent to the model. There is **no secret redaction**. Don't
  `read` a pane you wouldn't paste into the model.
- **SSH host keys** use trust-on-first-use (`StrictHostKeyChecking=accept-new`): a
  new host is added automatically, but a **changed** key is rejected. wux never
  disables host-key checking.
- **No network surface.** stdio only — no port, no daemon, no inbound listener.
  Remote control rides your outbound SSH.
- **Individual-use boundary.** This is for the operator's own work on their own
  repos and subscription — not a multi-tenant gateway routing others' work through
  one account.

## Non-goals (this surface)

No web-terminal bridge, no network-exposed MCP endpoint, no per-run locks/leases,
no secret redaction, and no autonomous turn I/O / `wux wait` runtime.
