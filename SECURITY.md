# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** rather than opening a public
issue.

Use GitHub's private vulnerability reporting: open the repository's
[Security tab → "Report a vulnerability"](https://github.com/jvrck/wux/security/advisories/new).
This keeps the details private until a fix is available.

Please include:

- a description of the issue and its impact;
- the wux version (`wux --version`) and your platform;
- steps to reproduce, ideally a minimal proof of concept.

You can expect an initial acknowledgement within a few days. There is no bug
bounty program.

## Supported versions

wux ships as standalone [CalVer](https://calver.org) release binaries. Only the
latest release is supported; fixes ship in a new release rather than as backports
to older tags.

## Dependency scanning

wux scans its dependency tree for known vulnerabilities in CI (OSV-Scanner and
Trivy) and at release time (Trivy). See [docs/security.md](docs/security.md) for
the scanning policy and how suppressions are recorded.
