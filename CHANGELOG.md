# Changelog

Release notes in this file are human-curated and user-facing. Keep each release
section focused on behavior, operations, compatibility, and upgrade impact rather
than duplicating the full PR log.

This changelog begins at the first public release of wux. Development history
prior to the public launch was maintained in a separate private repository and is
intentionally not reproduced here.

## Unreleased

## 2026.06.21.1

Initial public release.

Includes a first-run fix so the initial `wux run` on a host with no existing
tmux server starts cleanly (previously the first session could fail when no
tmux server was already running).

### Added

- Durable tmux-backed worker sessions for `shell`, `claude`, and `codex` backends.
- Local and SSH-targeted session lifecycle commands: `run`, `send`, `read`, `attach`, `handoff`, `mark`, `stop`, and `prune`.
- Structured output and readiness primitives for autonomous-agent workflows.
- Operator-first stdio MCP control surface for opening, listing, sending, reading, interrupting, stopping, and viewing Wux runs.
- Standalone CalVer release binaries, install script, and upgrade command.
