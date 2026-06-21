# Contributing to wux

Thanks for your interest in wux — a small, single-binary CLI that wraps durable
tmux sessions for `shell`, `claude`, and `codex` agent workers. Issues and pull
requests are welcome.

## Development

wux is a [Bun](https://bun.sh) + TypeScript project. You need Bun `>=1.3.9` and
`tmux` on your `PATH`.

```bash
bun install
bun run typecheck   # tsc --noEmit (strict) — the only static check
bun test            # full suite (exercises real tmux and the filesystem)
bun run wux -- --help
```

- See [docs/running.md](docs/running.md) for running from source and
  [docs/building.md](docs/building.md) for compiling a standalone binary.
- The architecture, key invariants, and conventions are documented in
  [CLAUDE.md](CLAUDE.md).
- Tmux-dependent tests early-return when `tmux` is absent, so install `tmux` to run
  the full suite locally.

## Pull requests

- Keep changes focused — one logical change per PR.
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit and PR
  titles (`feat:`, `fix:`, `chore:`, `docs:`).
- `bun run typecheck` and `bun test` must pass.
- Update the docs alongside any behavior change, and keep
  [docs/commands.md](docs/commands.md) in sync with the command surface.

## Reporting bugs and security issues

- Bugs and feature requests: open a [GitHub issue](https://github.com/jvrck/wux/issues).
- Security vulnerabilities: please follow [SECURITY.md](SECURITY.md) and report
  privately — do not open a public issue.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
