# Releasing wux

wux releases are published as public GitHub Releases attached to CalVer git tags. Release assets are served over anonymous HTTPS, so downloading them (via `install.sh` or `wux upgrade`) needs no GitHub authentication.

## Version scheme

Release tags use zero-padded CalVer dates:

```text
YYYY.MM.DD
```

Example: `2026.06.12`.

Tags do not use a `v` prefix. If a second release is needed on the same day, append a numeric micro segment:

```text
YYYY.MM.DD.N
```

Example: `2026.06.12.2`.

Compare release versions numerically and component-wise, not as strings and not as semver. For example, `2026.06.12.10` is newer than `2026.06.12.2` because `10 > 2` in the fourth component.

Source runs are intentionally stamped as `0.0.0-dev`:

```bash
bun run wux -- --version
```

Release binaries are stamped by the release workflow with the tag value, so `wux --version` and `wux -v` print the bare CalVer string.

## Cut a release

1. Make sure `main` contains the commit to release and CI is green.
2. Review merged PRs since the previous CalVer tag and update
   `CHANGELOG.md` with user-visible entries under `Unreleased`.
3. Pick the tag for today:

```bash
TAG=$(date +%Y.%m.%d)
```

If that tag already exists and a same-day re-release is required, append the next micro number, for example:

```bash
TAG=$(date +%Y.%m.%d).2
```

4. Promote `Unreleased` to the chosen release tag and create a fresh empty
   `Unreleased` section for future work.
5. Confirm breaking changes and migration notes are explicit in
   `CHANGELOG.md`, or state that there are none.
6. Create and push the tag:

```bash
git fetch --tags origin
git tag "$TAG"
git push origin "$TAG"
```

Pushing a `20[0-9][0-9].*` tag triggers `.github/workflows/release.yml`.
The workflow cross-compiles the release binaries, validates the built artifacts
on their target runtimes, generates and scans a CycloneDX SBOM, creates
`SHA256SUMS`, extracts the matching `CHANGELOG.md` section, then creates the
GitHub Release only after validation passes. The release job fails before
publication if `CHANGELOG.md` has no section matching the tag or that section is
empty. GitHub generated notes are not the release narrative; use the matching
`CHANGELOG.md` section for GitHub Release notes.

If you have already cross-built, generated and scanned the SBOM, validated the
assets locally, and staged release artifacts in the current directory, extract
the notes file first:

```bash
scripts/extract-changelog-section.sh "$TAG" CHANGELOG.md > /tmp/wux-release-notes.md
```

Then create the release with those curated notes:

```bash
gh release create "$TAG" --repo jvrck/wux --notes-file /tmp/wux-release-notes.md wux-* sbom.cdx.json SHA256SUMS
```

When using a one-off tag command instead of a saved `TAG` variable, keep the
same changelog extraction step and pass the same notes file:

```bash
TAG=$(date +%Y.%m.%d)
scripts/extract-changelog-section.sh "$TAG" CHANGELOG.md > /tmp/wux-release-notes.md
gh release create "$TAG" --repo jvrck/wux --notes-file /tmp/wux-release-notes.md wux-* sbom.cdx.json SHA256SUMS
```

## Assets

Each release contains exactly these assets:

```text
wux-linux-x64
wux-linux-arm64
wux-darwin-arm64
wux-linux-x64-musl
sbom.cdx.json
SHA256SUMS
```

The binary assets follow the `wux-<os>-<arch>` naming convention, with one extra libc-qualified Linux variant:

- `wux-linux-x64` targets x86_64 Linux systems using glibc, which is the common default for Debian, Ubuntu, Fedora, and many other distributions.
- `wux-linux-arm64` targets ARM64 Linux systems using glibc.
- `wux-darwin-arm64` targets Apple Silicon macOS.
- `wux-linux-x64-musl` targets x86_64 Linux systems using musl, such as Alpine Linux or other musl-based environments.
- `sbom.cdx.json` is the CycloneDX software bill of materials generated from the release checkout and scanned before publishing.

There is no `darwin-x64` release target.

## Verify a release

After the workflow finishes, verify the release and checksums:

```bash
set -euo pipefail
TAG=2026.06.12

gh release view "$TAG" -R jvrck/wux --json assets --jq '.assets[].name'
gh release download "$TAG" -R jvrck/wux -p 'wux-linux-x64' -O /tmp/wux-linux-x64 --clobber
gh release download "$TAG" -R jvrck/wux -p 'sbom.cdx.json' -O /tmp/sbom.cdx.json --clobber
gh release download "$TAG" -R jvrck/wux -p 'SHA256SUMS' -O /tmp/SHA256SUMS --clobber
chmod +x /tmp/wux-linux-x64
/tmp/wux-linux-x64 --version
( cd /tmp && grep 'wux-linux-x64$' SHA256SUMS | sha256sum -c - )
( cd /tmp && grep 'sbom.cdx.json$' SHA256SUMS | sha256sum -c - )
```

`/tmp/wux-linux-x64 --version` should print the tag, for example `2026.06.12`.

The tag-triggered release workflow already runs architecture coverage before
publishing. To recheck the assets that were actually published, run the manual
post-publish release asset validation workflow against the tag:

```bash
gh workflow run validate-release.yml -f tag="$TAG"
```

That workflow downloads the published binaries and `SHA256SUMS`, then validates
each binary on its target architecture or runtime environment. The release
workflow itself generates and scans `sbom.cdx.json` before publishing. See
[release-validation.md](release-validation.md).
