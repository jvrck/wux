# Security Scanning

wux uses OSV-Scanner and Trivy as its dependency security baseline. The repo keeps
the text `bun.lock` lockfile; do not replace it with `bun.lockb`, because the
security workflows scan the text lockfile.

## Local Scans

Install the pinned CI scanner versions:

```bash
bun run security:install
```

Run the same scanner commands locally:

```bash
bun run security:osv
bun run security:trivy
bun run security:gate
bun run security:license
bun run security:sbom
bun run security:sbom:scan
```

`security:gate` is the blocking policy: HIGH and CRITICAL findings with available
fixes fail the command. Lower severities and unfixed findings remain reporting
signals unless the policy changes.

## CI Behavior

`.github/workflows/security.yml` runs on pull requests, pushes to `main` and
`epic/**`, a weekly schedule, and manual dispatch.

- `dependency-scan` is reporting mode. It runs OSV-Scanner against `bun.lock` and
  Trivy filesystem scanning with dev dependencies included, then uploads SARIF
  report artifacts for review without blocking the rollout.
- `security-gate` blocks PR/push/manual runs on HIGH or CRITICAL fixable Trivy
  vulnerability findings (`--ignore-unfixed --exit-code 1`), and on any
  non-permissive dependency license
  (`--scanners license --severity UNKNOWN,MEDIUM,HIGH,CRITICAL`).
- Scheduled runs execute the same HIGH/CRITICAL fixable gate so GitHub Actions
  notifies maintainers, but they do not block any merge. Track scheduled
  findings in a GitHub issue.

## Release SBOM

The tag-triggered release workflow generates `sbom.cdx.json` with Trivy, includes
dev dependencies for advisory coverage, scans that SBOM for HIGH and CRITICAL
fixable vulnerabilities before publishing, and uploads `sbom.cdx.json` with the
release binaries and `SHA256SUMS`.

## License Compatibility

Before publishing, the resolved dependency tree's licenses are scanned for terms
incompatible with wux's MIT license:

```bash
bun run security:license   # trivy fs --scanners license --severity UNKNOWN,MEDIUM,HIGH,CRITICAL --exit-code 1 .
```

Trivy classifies each dependency's license into a category and severity:
permissive/notice/unencumbered (MIT, BSD, ISC, Apache-2.0, …) → `LOW`;
reciprocal/weak-copyleft (MPL, EPL) → `MEDIUM`; restricted/copyleft (GPL, LGPL,
AGPL) → `HIGH`; forbidden/proprietary → `CRITICAL`; and unidentified licenses →
`UNKNOWN`. The gate runs at `--severity UNKNOWN,MEDIUM,HIGH,CRITICAL`, so **only
permissive (`LOW`) licenses pass** — anything reciprocal, restricted, forbidden,
or `UNKNOWN` **fails the build** and requires a human decision (replace the
dependency, obtain an exception, or relicense). Do not auto-remove or relicense.

Accepted (allowlisted) license IDs — all permissive and MIT-compatible:

- `MIT`
- `ISC`
- `BSD-2-Clause`, `BSD-3-Clause`
- `Apache-2.0`
- `0BSD`, `Unlicense`, `CC0-1.0`

As of the public launch the production dependency tree resolves to only `MIT`,
`BSD-2-Clause`, `BSD-3-Clause`, and `ISC` licenses (0 `UNKNOWN`, 0 HIGH/CRITICAL).
The same Trivy stack also emits the per-package license data carried in the
release `sbom.cdx.json`.

## Suppressions

Suppression files are versioned:

- `osv-scanner.toml`
- `.trivyignore.yaml`

Every suppression must include:

- advisory ID;
- reason;
- owner;
- tracking issue or note;
- expiry or review date.

For OSV-Scanner, use `ignoreUntil` and put owner/tracking metadata in `reason`.
For Trivy, use `expired_at` and put owner/tracking metadata in `statement`.

### Active suppressions

- **hono HTTP-surface advisories** — `CVE-2026-54290` (CORS middleware Origin
  reflection; the only HIGH/fixable one, so the only one the Trivy gate blocks) plus
  the lower-severity `CVE-2026-54286`–`54289` (`serve-static` path traversal, AWS
  Lambda `Set-Cookie` merging, Body-Limit bypass on Lambda, and Lambda@Edge header
  handling). `hono` is a transitive dependency of `@modelcontextprotocol/sdk`'s
  HTTP/SSE transport. wux is a CLI that runs the **stdio** MCP transport only — no HTTP
  server, no listening port, no CORS middleware, no AWS Lambda/Lambda@Edge adapter, and
  no static-file serving — so every affected surface is never imported or executed and
  is tree-shaken out of the `bun build --compile` binary. Suppressed in
  `.trivyignore.yaml` (the HIGH CORS advisory, which the gate would otherwise block)
  and `osv-scanner.toml` (all five, each labelled with its advisory) with a 2026-09-21
  review date; re-review then or when the SDK resolves `hono>=4.12.25`.
