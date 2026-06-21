#!/usr/bin/env bash
set -euo pipefail

OSV_SCANNER_VERSION="${OSV_SCANNER_VERSION:-2.3.8}"
TRIVY_VERSION="${TRIVY_VERSION:-0.71.0}"
TOOL_DIR="${WUX_SECURITY_TOOLS_DIR:-$HOME/.local/bin}"

osv_tag="v${OSV_SCANNER_VERSION#v}"
trivy_version="${TRIVY_VERSION#v}"
trivy_tag="v$trivy_version"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    osv_asset="osv-scanner_linux_amd64"
    trivy_asset="trivy_${trivy_version}_Linux-64bit.tar.gz"
    ;;
  Linux-aarch64 | Linux-arm64)
    osv_asset="osv-scanner_linux_arm64"
    trivy_asset="trivy_${trivy_version}_Linux-ARM64.tar.gz"
    ;;
  Darwin-x86_64)
    osv_asset="osv-scanner_darwin_amd64"
    trivy_asset="trivy_${trivy_version}_macOS-64bit.tar.gz"
    ;;
  Darwin-arm64)
    osv_asset="osv-scanner_darwin_arm64"
    trivy_asset="trivy_${trivy_version}_macOS-ARM64.tar.gz"
    ;;
  *)
    echo "unsupported platform for security tool installer: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$TOOL_DIR"

download() {
  local url="$1"
  local output="$2"
  curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error "$url" --output "$output"
}

check_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$file"
  else
    shasum -a 256 -c "$file"
  fi
}

cd "$work_dir"

download "https://github.com/google/osv-scanner/releases/download/$osv_tag/$osv_asset" "$osv_asset"
download "https://github.com/google/osv-scanner/releases/download/$osv_tag/osv-scanner_SHA256SUMS" osv-scanner_SHA256SUMS
grep -F "  $osv_asset" osv-scanner_SHA256SUMS > osv-scanner_SHA256SUMS.one
check_sha256 osv-scanner_SHA256SUMS.one
install -m 0755 "$osv_asset" "$TOOL_DIR/osv-scanner"

download "https://github.com/aquasecurity/trivy/releases/download/$trivy_tag/$trivy_asset" "$trivy_asset"
download "https://github.com/aquasecurity/trivy/releases/download/$trivy_tag/trivy_${trivy_version}_checksums.txt" trivy_checksums.txt
grep -F "  $trivy_asset" trivy_checksums.txt > trivy_checksums.txt.one
check_sha256 trivy_checksums.txt.one
tar -xzf "$trivy_asset" trivy
install -m 0755 trivy "$TOOL_DIR/trivy"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$TOOL_DIR" >> "$GITHUB_PATH"
fi

"$TOOL_DIR/osv-scanner" --version
"$TOOL_DIR/trivy" --version
