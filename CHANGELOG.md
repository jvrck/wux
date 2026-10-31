# Changelog

Release notes in this file are human-curated and user-facing. Keep each release
section focused on behavior, operations, compatibility, and upgrade impact rather
than duplicating the full PR log.

This changelog begins at the first public release of wux. Development history
prior to the public launch was maintained in a separate private repository and is
intentionally not reproduced here.

## Unreleased

### Changed

- Unknown commands and unrecognized options now list valid choices and suggest a close spelling without accepting aliases. A repeated valid option keeps its plain `unknown option: <flag>` message.
- Codex hook completion now fails closed and is correlated to the latest sent input using Codex's trimmed input form. Ambiguous duplicate sends fall back without hook completion; auxiliary title-generation notifications remain diagnosable in `events.jsonl` but cannot settle `wait` or `result`.

### Fixed

- Fixed macOS test cleanup to resolve tmux socket parents without resolving Unix sockets directly.

## 2026.10.24

No breaking changes.

### Added

- Added derived tmux liveness to JSON status output and explicit prune
  reconciliation and prefix selection.
- Added type-prefixed issue templates and CONTRIBUTING guidance for the
  nine-section issue format.

### Security

- Updated transitive body-parser to 2.4.0 for CVE-2026-111181, Zod to 4.6.7
  for CVE-2023-54404, and its required qs from 6.16.0 to 6.16.1.

### Fixed

- Isolated the test suite's tmux servers from an invoking terminal and guarded
  test cleanup against servers outside test-owned socket roots.
- Accepted command options before or after a run name for stop, interrupt, wait,
  result, and handoff.

## 2026.10.17

No breaking changes.

### Added

- Added the durable `grok` backend, including MCP open support and advisory Grok
  PATH/version checks in `remotes doctor`. Grok uses explicit hook/sentinel
  completion evidence only; quiet panes never report done.

## 2026.10.03

No breaking changes.

### Security

- Updated transitive dependencies to patched releases, resolving advisories in
  fast-uri, hono, body-parser, qs, and ip-address.

### Dependencies and compatibility

- Updated the Model Context Protocol SDK to 1.32, Zod to 4.6, and Bun type
  definitions to 1.4.
- `wux mcp`: with SDK 1.32, a tools/call request that omits arguments is now
  treated as an empty arguments object (tools with required inputs still reject
  it); tool names and input schemas are unchanged.
- Updated CI and release workflows to `actions/checkout` v6.1.0.

## 2026.08.17

### Fixed

- Bind new runs to their exact creating tmux socket so lifecycle commands keep
  routing correctly across simultaneous tmux servers; legacy run metadata keeps
  its ambient-server fallback.

### Security

- Add weekly grouped routine minor/patch Dependabot version maintenance for Bun
  and GitHub Actions, plus supported immediate GitHub Actions security updates;
  OSV-Scanner and Trivy continue to detect Bun vulnerabilities for deliberate
  maintainer remediation through ordinary reviewed work.

## 2026.08.04

### Security

- Updated transitive dependencies included through the MCP SDK to patched releases, resolving four HIGH-severity dependency advisories.

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
