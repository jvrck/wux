# End-to-End Testing

`wux` end-to-end coverage uses public GitHub-hosted infrastructure by default.
Self-hosted runners can still be useful as a high-fidelity backstop, but they are not required for the default suite.

## GitHub Actions Coverage

`.github/workflows/e2e.yml` runs on pull requests and through manual
`workflow_dispatch`.

The workflow has two Ubuntu jobs:

1. `binary-smoke` builds `dist/wux` from the current checkout, then runs
   `scripts/smoke-release-asset.sh` against the compiled binary with fresh
   state under `$RUNNER_TEMP`.
2. `remote-ssh-smoke` builds the same binary, verifies Docker Compose is
   available, and runs `scripts/smoke-remote-ssh.sh` to exercise the real
   `wux --host remote ...` forwarding path inside a Compose network.

Both jobs upload diagnostics only on failure. Artifacts include command output,
tmux session listings, environment details, and any available `meta.json`,
`pane.log`, and `events.jsonl` files.

## Local Binary Smoke

Build the development binary and run the same local lifecycle smoke used by the
workflow:

```bash
bun run build
WUX_BIN="$PWD/dist/wux" \
  EXPECTED_VERSION=0.0.0-dev \
  WUX_SMOKE_ROOT="$(mktemp -d)" \
  scripts/smoke-release-asset.sh
```

This validates the compiled binary can start a tmux-backed shell run, send input,
read captured output, report status, stop the run, and persist state files.

## Remote SSH Smoke

The remote smoke provisions an isolated Docker Compose environment with two
services:

1. `remote` runs `sshd`, `tmux`, and the just-built `wux` binary.
2. `controller` runs the same binary and drives the real `wux --host remote ...`
   contract over SSH.

Compose gives the SSH target a stable `remote` hostname on the project network,
so the test does not bind host port 22, stop the runner's system SSH service, or
modify the runner's normal SSH trust state. The generated `authorized_keys`
entry forces remote commands to use an isolated `XDG_STATE_HOME` under the
container-mounted state directory.

```bash
bun run build
WUX_BIN="$PWD/dist/wux" \
  WUX_REMOTE_SMOKE_ROOT="$(mktemp -d)" \
  scripts/smoke-remote-ssh.sh
```

The host script needs Docker, Docker Compose, and `ssh-keygen`. GitHub-hosted Ubuntu runners provide Docker and Compose; local runs need a running Docker
engine. On macOS, build a Linux binary for the Compose image architecture first.
For example, use `--target=bun-linux-x64` when `DOCKER_DEFAULT_PLATFORM` is
`linux/amd64`, or `--target=bun-linux-arm64` for `linux/arm64`.

## Optional Self-Hosted Compute

Keep self-hosted runners as optional `workflow_dispatch` or
scheduled coverage for cases GitHub-hosted runners cannot model: long-running
workers, private network paths, proxy jump behavior, or real agent backends with
secrets. Those jobs should stay separate from the required public path unless
they become reliable and reproducible for outside contributors.
