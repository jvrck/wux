# Branch And PR Previews

Preview builds let agents and developers test a branch or pull request before it
is released. They are not releases, do not update `latest`, and should not
replace a stable `wux` installation outside a dedicated preview environment.

Use previews for branch-specific validation, remote-host checks, and agent
handoffs where the exact source SHA matters.

## Preview Types

There are two supported preview paths:

1. Source checkout preview: run `wux` from a checked-out branch with Bun. This is
   the path that produces a runnable preview binary on a host.
2. GitHub Actions cross-compile gate: `.github/workflows/preview.yml` cross-builds
   the release target set from the requested ref and records a build manifest
   (versions and checksums) in the workflow run summary. It proves the ref
   compiles for every release target and records its fingerprints; it does not
   upload downloadable binaries.

The preview workflow complements `.github/workflows/e2e.yml`; it does not
recreate the E2E lifecycle and remote SSH smoke jobs. PRs should still rely on
the E2E workflow for tmux lifecycle and `--host` forwarding coverage. See
[e2e.md](./e2e.md).

## Source Checkout Preview

Use a source checkout when the target host has Bun and you want a runnable
preview binary with the fastest iteration loop.

```bash
git fetch origin <branch-or-pr-ref>
git worktree add ../wux-preview <branch-or-pr-ref>
cd ../wux-preview
bun install --frozen-lockfile
bun run typecheck
bun test
bun run wux -- --version
```

Source previews report `0.0.0-dev` from `wux --version`. Report the git SHA as
the preview identity:

```bash
git rev-parse HEAD
```

Run commands through the source entrypoint:

```bash
bun run wux -- status
bun run wux -- run shell --name preview-smoke --cwd "$PWD"
```

For isolated agent testing, keep state out of the developer's normal state
directory:

```bash
XDG_STATE_HOME="$(mktemp -d)" bun run wux -- status
```

To produce a standalone preview binary from a checkout, cross-compile it the
same way the release and preview workflows do:

```bash
SHORT_SHA="$(git rev-parse --short=12 HEAD)"
bun build src/index.ts --compile --target=bun-linux-x64 \
  --define "process.env.WUX_VERSION=\"0.0.0-preview.$SHORT_SHA\"" \
  --outfile dist/wux-linux-x64
./dist/wux-linux-x64 --version
```

## GitHub Actions Cross-Compile Gate

`.github/workflows/preview.yml` builds preview binaries from the requested ref.
It cross-compiles the same binary asset set used by releases, stamps each binary
with the preview version, writes `BUILD_INFO.json` and `SHA256SUMS`, and records
that manifest in the workflow **run summary**.

Preview binaries are **not** uploaded as Actions artifacts. Per-PR preview
artifacts previously dominated account-wide Actions storage (#148) and tripped
the artifact quota, which wedged the workflow. The cross-compile gate instead
proves the ref builds for every release target and publishes its fingerprints in
the run summary. To get a runnable binary, use a source checkout (above) or the
published GitHub Release assets.

The release asset set the gate cross-compiles, with the preview version stamp:

```text
wux-linux-x64
wux-linux-arm64
wux-darwin-arm64
wux-linux-x64-musl
```

```text
0.0.0-preview.<short-sha>
```

Because that version is not CalVer, `wux upgrade` treats preview binaries as
non-release builds and refuses to replace them through the stable upgrade path.

`BUILD_INFO.json` records the requested ref, checked-out SHA, preview version,
artifact name, repository, workflow run, and asset list. The run summary embeds
`BUILD_INFO.json` and `SHA256SUMS` so the exact source identity and per-target
checksums are auditable from the run page.

### Trigger A Preview Build

Pull requests to `main` run the preview workflow automatically. To request a
preview for an arbitrary branch, tag, or SHA:

```bash
gh workflow run preview.yml -R jvrck/wux --ref main -f ref=<branch-or-sha>
```

Find the run and read its summary, which carries `BUILD_INFO.json` and the
per-target `SHA256SUMS`:

```bash
RUN_ID="$(gh run list -R jvrck/wux --workflow preview.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run view "$RUN_ID" -R jvrck/wux
echo "Summary: $(gh run view "$RUN_ID" -R jvrck/wux --json url --jq '.url')"
```

The `preview_version` field in the summarized `BUILD_INFO.json` is the identity to
report; match it against the `wux --version` of any binary you build for the same
SHA.

### Smoke A Preview Build Locally

The gate does not produce a downloadable binary, so smoke a binary you built
from the same source (source checkout above) or a published release asset. Use
the existing release smoke script from a repo checkout:

```bash
cd /path/to/wux
PREVIEW_BIN="$PWD/dist/wux-linux-x64"
WUX_BIN="$PREVIEW_BIN" \
  EXPECTED_VERSION="$("$PREVIEW_BIN" --version)" \
  WUX_SMOKE_ROOT="$(mktemp -d)" \
  scripts/smoke-release-asset.sh
```

For remote SSH behavior, use the existing E2E workflow or script instead of
duplicating it in the preview workflow. Choose the Linux preview asset that
matches the Docker target architecture:

```bash
cd /path/to/wux
WUX_BIN="$PWD/dist/wux-linux-x64" \
  WUX_REMOTE_SMOKE_ROOT="$(mktemp -d)" \
  scripts/smoke-remote-ssh.sh
```

## Remote Host Usage

Use `wux --remote <name>` when the preview host is configured as a named remote.
Use `wux --host <host>` for an ad hoc raw SSH target. Raw `--host` resolves the
preview `wux` on the remote at runtime — a `--host-wux <path>` hint first, then
`~/.local/bin/wux`, then a login-shell lookup, then a bare `wux` on the
non-interactive SSH `PATH` — so a `~/.local/bin` install (or `--host-wux
<path>` pinning the preview binary) works without a PATH change; named remotes
can instead point at a custom `--wux-path`.

Use a dedicated preview user, preview host, or sandbox path. Do not replace a
production user's stable `$HOME/.local/bin/wux` or `/usr/local/bin/wux`.

For a binary preview on a Linux x64 glibc host, build it from a checkout (see
[Source Checkout Preview](#source-checkout-preview)) and copy it to the host:

```bash
SHORT_SHA="$(./dist/wux-linux-x64 --version | sed 's/^0.0.0-preview.//')"
ssh preview-host "mkdir -p ~/.local/share/wux/previews/$SHORT_SHA ~/.local/bin"
scp dist/wux-linux-x64 "preview-host:~/.local/share/wux/previews/$SHORT_SHA/wux"
ssh preview-host "chmod 0755 ~/.local/share/wux/previews/$SHORT_SHA/wux"
ssh preview-host "ln -sfn ~/.local/share/wux/previews/$SHORT_SHA/wux ~/.local/bin/wux"
ssh preview-host "command -v wux && wux --version"
```

Then run from the controller:

```bash
wux remotes add preview preview-host --wux-path /home/preview/.local/bin/wux --cwd /tmp
wux --remote preview status
wux --remote preview run shell --name preview-remote --cwd /tmp

# Or use raw SSH forwarding for an ad hoc host:
wux --host preview-host status
wux --host preview-host run shell --name preview-remote --cwd /tmp
```

For a source checkout preview on a dedicated remote user:

```bash
ssh preview-host "git clone git@github.com:jvrck/wux.git ~/src/wux-preview"
ssh preview-host "cd ~/src/wux-preview && git fetch origin <branch-or-sha> && git checkout <branch-or-sha>"
ssh preview-host "cd ~/src/wux-preview && bun install --frozen-lockfile"
ssh preview-host "mkdir -p ~/.local/bin && cat > ~/.local/bin/wux <<'EOF'
#!/usr/bin/env sh
cd \"\$HOME/src/wux-preview\" && exec bun run src/index.ts \"\$@\"
EOF
chmod 0755 ~/.local/bin/wux"
ssh preview-host "wux --version && git -C ~/src/wux-preview rev-parse HEAD"
```

Raw `--host` resolves the preview `wux` on the remote, so the `~/.local/bin/wux`
symlink above is enough — no non-interactive `PATH` change is required to test it.
If `~/.local/bin/wux` is absent and `ssh preview-host 'command -v wux'` also
prints nothing, pass `--host-wux <absolute-path>` to point raw `--host` at the
preview binary, or configure a named remote with its explicit absolute
`--wux-path`. Do not use `~` in `--host-wux`/`--wux-path`; Wux stores and
shell-quotes the path exactly, so remote shell tilde expansion will not run.

## Rollback And Removal

Stop preview runs before removing the preview binary or checkout:

```bash
wux status
wux stop <run-name> --yes
```

For binary previews, remove the preview symlink and SHA-scoped directory from
the preview user:

```bash
ssh preview-host "test -L ~/.local/bin/wux && rm ~/.local/bin/wux"
ssh preview-host "rm -rf ~/.local/share/wux/previews/<short-sha>"
```

For source checkout previews, remove the worktree or clone after all runs are
stopped:

```bash
git worktree remove ../wux-preview
```

If the preview used an isolated state root, delete that temporary directory after
collecting any diagnostics that need to be reported.

## Agent Reporting

When an agent tests a preview, report the exact preview identity and validation
surface:

- Preview path: source checkout or GitHub Actions cross-compile gate.
- Ref and SHA: `git rev-parse HEAD` for source, or the `BUILD_INFO.json` fields
  in the workflow run summary for the gate.
- Binary version: `wux --version`.
- Checks run: `bun run typecheck`, `bun test`, preview workflow run ID, E2E
  workflow run ID, local smoke, or remote smoke.
- Remote target: host alias, platform asset used, and whether a dedicated
  preview user/path was used; include whether `--remote` or raw `--host` drove
  the smoke.
- Integrity result: `SHA256SUMS` verification against the run-summary manifest
  for binaries built from the same SHA.
- Rollback: preview runs stopped and preview binary/checkouts removed, or the
  reason they were intentionally left in place.

Do not report a preview as a release. Do not claim `install.sh`, `wux upgrade`,
or the stable release assets were changed unless a separate release task actually
changed them.
