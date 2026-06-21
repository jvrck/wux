# Release Asset Validation

Release validation proves that each `wux` executable asset can be installed as an executable and used for a real tmux-backed shell lifecycle on a compatible target.

There are two validation modes:

- Pre-publish validation in `.github/workflows/release.yml` downloads build artifacts from the current workflow run and blocks GitHub Release creation until all required smoke jobs pass.
- Post-publish validation in `.github/workflows/validate-release.yml` is manually triggered with a tag, downloads already published release assets plus `SHA256SUMS`, and rechecks the assets that users can download.

The default validation path uses public GitHub-hosted infrastructure. As of June 2026, GitHub's hosted-runner reference provides standard hosted Linux x64, Linux arm64 (`ubuntu-24.04-arm`), and arm64 macOS (`macos-15`) runners, so all release assets can be exercised on public GitHub-hosted runners. See GitHub's runner reference: <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>.

## Coverage Strategy

| Asset | Required path | Environment | Notes |
| --- | --- | --- | --- |
| `wux-linux-x64` | Public GitHub-hosted | `ubuntu-latest` | Native glibc Linux smoke. |
| `wux-linux-x64-musl` | Public GitHub-hosted | Alpine container on `ubuntu-latest` | Runs the binary inside Alpine with `libstdc++` installed so musl compatibility is tested directly. |
| `wux-linux-arm64` | Public GitHub-hosted | `ubuntu-24.04-arm` | Native arm64 Linux smoke. |
| `wux-darwin-arm64` | Public GitHub-hosted | `macos-15` | Native Apple Silicon macOS smoke. |

Optional self-hosted coverage can still be useful as a backstop, but it is not required for the default validation path. If GitHub-hosted arm64 capacity becomes unavailable or too flaky for this repo, add a separate optional workflow or matrix entry for self-hosted labels such as `self-hosted`, `linux`, `arm64` or `self-hosted`, `macOS`, `ARM64`. Keep those jobs non-required unless they are reliable for outside contributors.

QEMU is not part of the default strategy because native hosted runners exist for the current release assets. If a future architecture lacks native hosted coverage, use QEMU as advisory compatibility smoke first, then decide whether it is stable enough to block release validation.

## Pre-publish Workflow

`.github/workflows/release.yml` runs automatically for `20[0-9][0-9].*` tag pushes. Its release path is:

```text
build -> validate-native + validate-linux-musl -> release
```

The validation jobs download the current run's build artifacts with `actions/download-artifact`, not `gh release download`, because the GitHub Release does not exist yet. Native validation runs `wux-linux-x64`, `wux-linux-arm64`, and `wux-darwin-arm64` on their matching hosted runners. Musl validation runs `wux-linux-x64-musl` inside an Alpine container with `libstdc++` and `tmux` installed.

Each pre-publish job checks that the binary exists, makes it executable, verifies `wux --version` against the tag, verifies `wux --help`, and runs the shared lifecycle smoke. The publish job generates and scans `sbom.cdx.json`, creates `SHA256SUMS` for the binaries and SBOM, and creates the GitHub Release only after validation and SBOM scanning pass.

## Post-publish Workflow

`.github/workflows/validate-release.yml` is manually run with `workflow_dispatch`:

```bash
gh workflow run validate-release.yml -f tag=2026.06.12
```

The post-publish workflow downloads the requested release asset and `SHA256SUMS` with the workflow `GITHUB_TOKEN`, verifies that `SHA256SUMS` contains the asset, checks the checksum, makes the binary executable, installs it into a temporary `bin/wux`, verifies `wux --version` against the tag, runs `wux --help`, and then runs the shared lifecycle smoke.

The post-publish workflow is intentionally separate from normal PR CI. It is for post-release or manual validation of already published assets, not for every pull request.

## Smoke Script

`scripts/smoke-release-asset.sh` validates one downloaded binary. Required inputs:

```bash
WUX_BIN=/tmp/wux-linux-x64 \
EXPECTED_VERSION=2026.06.12 \
scripts/smoke-release-asset.sh
```

The script uses an isolated `XDG_STATE_HOME`, starts `wux run shell`, sends a command that prints a smoke token not present in the typed command, waits for `wux read --tail 50` to capture it, verifies `wux status`, stops the run with `wux stop --yes`, and checks that `meta.json`, `pane.log`, and `events.jsonl` are present and sane.

Set `WUX_SMOKE_ROOT` to keep state under a known directory. Set `WUX_SMOKE_DIAG_DIR` to copy failure diagnostics for artifact upload.

## Failure Artifacts

On failure, the workflow uploads diagnostics for the failed asset. The artifact includes command transcripts, `tmux list-sessions`, environment details, and any available run state files:

```text
meta.json
pane.log
events.jsonl
```

These artifacts should be enough to distinguish download/checksum problems from binary startup failures, missing `tmux`, lifecycle regressions, and log/state persistence problems.
