#!/usr/bin/env bash
# install-dual-review.sh — install the dual-review skill (Claude + Codex twins)
# from jvrck/wux into this machine's global skill dirs.
#
# Usage:   curl -fsSL <raw>/install-dual-review.sh | bash
#          WUX_REF=dual-review-dist bash install-dual-review.sh   # test from a branch
#
# Needs: curl. To RUN the skill afterwards: wux + claude + codex + gh authed.
set -euo pipefail

REF="${WUX_REF:-main}"
RAW="https://raw.githubusercontent.com/jvrck/wux/${REF}"
CL="$HOME/.claude/skills/dual-review"
AG="$HOME/.agents/skills/dual-review"

mkdir -p "$CL/scripts" "$AG"

# Claude twin: SKILL.md + the shared deterministic helper (one canonical copy).
curl -fsSL "$RAW/.claude/skills/dual-review/SKILL.md"               -o "$CL/SKILL.md"
curl -fsSL "$RAW/.claude/skills/dual-review/scripts/dual-review.sh" -o "$CL/scripts/dual-review.sh"
chmod +x "$CL/scripts/dual-review.sh"

# Codex twin: SKILL.md (references the shared helper above).
curl -fsSL "$RAW/.agents/skills/dual-review/SKILL.md"              -o "$AG/SKILL.md"

echo "installed dual-review skill (ref=${REF}):"
echo "  claude: $CL/SKILL.md + scripts/dual-review.sh"
echo "  codex:  $AG/SKILL.md  (shared helper at ~/.claude/skills/dual-review/scripts)"
echo "verify: ls -R $CL $AG"
