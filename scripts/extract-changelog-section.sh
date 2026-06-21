#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: scripts/extract-changelog-section.sh <tag> [CHANGELOG.md]" >&2
  exit 2
fi

tag="$1"
changelog="${2:-CHANGELOG.md}"

if [ ! -f "$changelog" ]; then
  echo "::error::CHANGELOG.md not found: $changelog" >&2
  exit 1
fi

set +e
notes="$(
  awk -v tag="$tag" '
    BEGIN {
      in_section = 0
      found = 0
    }

    /^##[[:space:]]+/ {
      heading = $0
      sub(/^##[[:space:]]+/, "", heading)
      sub(/[[:space:]]+$/, "", heading)

      if (in_section) {
        exit
      }

      if (heading == tag) {
        in_section = 1
        found = 1
        next
      }
    }

    in_section {
      print
    }

    END {
      if (!found) {
        exit 42
      }
    }
  ' "$changelog"
)"
status="$?"
set -e

if [ "$status" -eq 42 ]; then
  echo "::error::CHANGELOG.md has no section for release tag $tag" >&2
  exit 1
fi

if [ "$status" -ne 0 ]; then
  echo "::error::failed to extract release notes from CHANGELOG.md for $tag" >&2
  exit 1
fi

if ! printf '%s\n' "$notes" | grep -Eq '[^[:space:]]'; then
  echo "::error::CHANGELOG.md section for release tag $tag is empty" >&2
  exit 1
fi

printf '%s\n' "$notes"
