#!/usr/bin/env bash
# Install wux from a GitHub Release.
#
# Fetch and run:
#   curl -fsSL https://raw.githubusercontent.com/jvrck/wux/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/jvrck/wux/main/install.sh | bash -s -- --with-skills
#
# Detects the platform, downloads the matching wux-<os>-<arch> asset over
# anonymous HTTPS from the public GitHub Release, verifies its SHA256 checksum,
# and installs a `wux` binary on PATH. Re-running upgrades in place. No Bun and
# no GitHub auth required on the target host.
#
# Env overrides:
#   WUX_REPO     repo to install from        (default: jvrck/wux)
#   WUX_VERSION  CalVer tag or "latest"      (default: latest)
#   BIN_DIR      install directory           (default: $HOME/.local/bin)
#   WUX_SKILLS_DIR  skills destination root  (default: $HOME/.claude/skills)
set -euo pipefail

WUX_REPO="${WUX_REPO:-jvrck/wux}"
WUX_VERSION="${WUX_VERSION:-latest}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
WUX_SKILLS_DIR="${WUX_SKILLS_DIR:-$HOME/.claude/skills}"
WITH_SKILLS=0
DEFAULT_SKILLS=(wux wux-command wux-hub)

note() { printf '%s\n' "$*" >&2; }
die()  { printf 'wux install: %s\n' "$*" >&2; exit 1; }

parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --with-skills) WITH_SKILLS=1 ;;
      *) die "unknown option: $arg" ;;
    esac
  done
}

detect_asset() {
  local os arch
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
  if [ "$os" = linux ] && [ "$arch" = x64 ]; then
    if { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; } || [ -f /etc/alpine-release ]; then
      arch=x64-musl
    fi
  fi
  case "$os-$arch" in
    linux-x64|linux-arm64|linux-x64-musl|darwin-arm64) printf 'wux-%s-%s\n' "$os" "$arch" ;;
    *) die "no published binary for $os-$arch" ;;
  esac
}

verify_checksum() {  # <dir> <asset>
  local dir="$1" asset="$2"
  ( cd "$dir"
    grep -E "[[:space:]]\*?${asset}\$" SHA256SUMS > SHA256SUMS.one || die "SHA256SUMS has no entry for $asset"
    if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS.one
    elif command -v shasum   >/dev/null 2>&1; then shasum -a 256 -c SHA256SUMS.one
    else die "need sha256sum or shasum to verify the download"; fi )
}

download() {  # <tag> <asset> <destdir>
  local tag="$1" asset="$2" dest="$3"
  command -v curl >/dev/null 2>&1 || die "curl is required to download wux releases"

  # Public release assets are served anonymously from the releases/download URL
  # (302 → asset CDN). `latest` resolves to the newest full release. No gh, no
  # token, no API call — just the public asset URLs, checksum-verified below.
  local base
  if [ "$tag" = latest ]; then
    base="https://github.com/$WUX_REPO/releases/latest/download"
  else
    base="https://github.com/$WUX_REPO/releases/download/$tag"
  fi
  local name
  for name in "$asset" SHA256SUMS; do
    curl -fsSL "$base/$name" -o "$dest/$name" \
      || die "failed to download $name from $WUX_REPO release ($tag)"
  done
}

# Cleanup runs from the EXIT trap, after main() returns, so the temp dir must be
# a global (a `local` in main would be out of scope and trip `set -u` here).
tmp=""
cleanup() { [ -n "${tmp:-}" ] && rm -rf "$tmp"; return 0; }
trap cleanup EXIT

main() {
  local asset
  asset="$(detect_asset)"
  note "wux install: asset=$asset repo=$WUX_REPO version=$WUX_VERSION"

  tmp="$(mktemp -d)"
  download "$WUX_VERSION" "$asset" "$tmp"
  verify_checksum "$tmp" "$asset"

  mkdir -p "$BIN_DIR"
  cp "$tmp/$asset" "$BIN_DIR/.wux.new"
  chmod 0755 "$BIN_DIR/.wux.new"
  mv -f "$BIN_DIR/.wux.new" "$BIN_DIR/wux"
  note "installed: $BIN_DIR/wux ($("$BIN_DIR/wux" --version 2>/dev/null || echo '?'))"

  if [ "$WITH_SKILLS" = 1 ]; then
    install_skills
  fi

  if ! command -v tmux >/dev/null 2>&1; then
    note "WARNING: tmux not found — wux needs it for sessions."
    note "  install it with your package manager, e.g.: apt-get install tmux | apk add tmux | brew install tmux (you may need elevated privileges)"
  fi

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) note "NOTE: $BIN_DIR is not on your PATH. Add it (e.g. to ~/.zshenv or ~/.bash_profile):"
       note "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  note "For 'wux --host <this-host>' to work, wux must be on the NON-interactive ssh PATH:"
  note "  verify: ssh <host> 'command -v wux'  — if empty, install to a dir already on that PATH"
  note "  e.g.: BIN_DIR=/usr/local/bin (often writable with elevated privileges) and on the default PATH"
}

install_skills() {
  local skill dir path
  for skill in "${DEFAULT_SKILLS[@]}"; do
    dir="$WUX_SKILLS_DIR/$skill"
    path="$dir/SKILL.md"
    mkdir -p "$dir"
    "$BIN_DIR/wux" skills show "$skill" > "$path"
    note "installed skill: $path"
  done
}

parse_args "$@"
main "$@"
