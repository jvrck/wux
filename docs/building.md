# Building wux

## Build a standalone binary

```bash
bun run build
```

This runs `bun run scripts/generate-skills.ts && bun build src/index.ts --compile --outfile dist/wux`, regenerating the bundled companion skills and producing a single-file executable at `dist/wux`. `dist/` is git-ignored.

## Put it on PATH

```bash
cp dist/wux ~/.local/bin/wux   # or any directory on your PATH
wux --version
```

## Cross-compile

Pass `--target` to compile for another platform:

```bash
bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/wux-linux-x64
bun build src/index.ts --compile --target=bun-darwin-arm64 --outfile dist/wux-darwin-arm64
```

## Release builds

The tag-driven release workflow cross-compiles the supported release assets and stamps binaries with the CalVer tag. See [Releasing wux](./releasing.md) for the release runbook, asset naming convention, and glibc-vs-musl target guidance.

## Runtime dependencies

`--compile` bundles only the Bun/JS side. The compiled binary still shells out to `tmux` at runtime, and to `claude`/`codex` for those backends, so those executables must be on `PATH` wherever the binary runs.
