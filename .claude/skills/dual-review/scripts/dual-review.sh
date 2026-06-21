#!/usr/bin/env bash
# Host-agnostic mechanics for the dual-review skill.
#
# Both the Claude skill (.claude/skills/dual-review) and the Codex skill
# (.agents/skills/dual-review) call this script for the deterministic parts:
# resolving the review target, emitting the diff/changed files, posting per-agent
# review comments, and running the project's static checks.
#
# Reviewer spawning is host-specific and lives in each SKILL.md, NOT here. The
# skills prefer Wux-backed cross-agent reviewers when available and document
# direct fallback paths for environments without Wux.
set -euo pipefail

usage() {
  cat <<'EOF'
dual-review.sh — shared mechanics for the dual-review skill

Usage:
  dual-review.sh target [<pr>]       Print resolved target ("pr <N>" or "branch <base>...HEAD")
  dual-review.sh diff   [<pr>]       Print the unified diff under review
  dual-review.sh files  [<pr>]       List changed file paths
  dual-review.sh comment <agent> <pr> <md>
                                      Post or update one review comment from markdown file <md>
                                      <agent> must be "codex" or "claude"
  dual-review.sh check               Run the project's static checks (bun run typecheck && bun test)

Target resolution:
  - With <pr> (a gh PR selector: number, URL, or branch): the PR's diff is used.
  - Without <pr>: the current branch is compared against the remote base ref.
EOF
}

# The remote-tracking base ref (e.g. origin/main). Diffing against the remote
# ref is robust on fresh/CI checkouts where a local base branch may be absent or
# stale; falls back to origin/main when origin/HEAD is unset.
base_ref() {
  local ref
  ref="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "$ref" ]; then
    printf '%s\n' "${ref#refs/remotes/}"
  else
    printf 'origin/main\n'
  fi
}

cmd_target() {
  local pr="${1:-}"
  if [ -n "$pr" ]; then
    printf 'pr %s\n' "$pr"
  else
    printf 'branch %s...HEAD\n' "$(base_ref)"
  fi
}

cmd_diff() {
  local pr="${1:-}"
  if [ -n "$pr" ]; then
    gh pr diff "$pr"
  else
    git diff "$(base_ref)...HEAD"
  fi
}

cmd_files() {
  local pr="${1:-}"
  if [ -n "$pr" ]; then
    gh pr diff "$pr" --name-only
  else
    git diff --name-only "$(base_ref)...HEAD"
  fi
}

comment_marker() {
  local agent="${1:-}"
  case "$agent" in
    codex|claude) printf '<!-- dual-review:%s -->\n' "$agent";;
    *) return 1;;
  esac
}

comment_label() {
  local agent="${1:-}"
  case "$agent" in
    codex) printf 'Codex\n';;
    claude) printf 'Claude\n';;
    *) return 1;;
  esac
}

# Post one agent's review, updating in place if a prior one exists (keyed by the
# per-agent marker) so re-review rounds don't pile up duplicate comments.
cmd_comment() {
  local agent="${1:-}" pr="${2:-}" md="${3:-}"
  local marker label
  marker="$(comment_marker "$agent")" || {
    echo "comment requires <agent> to be codex or claude" >&2
    return 2
  }
  label="$(comment_label "$agent")"
  [ -n "$pr" ] || { echo "comment requires <pr>" >&2; return 2; }
  [ -f "$md" ] || { echo "comment requires an existing markdown file" >&2; return 2; }

  local num repo body existing
  # Accept any gh PR selector (number, URL, or branch) and resolve to a number
  # for the issue-comments REST API.
  num="$(gh pr view "$pr" --json number --jq .number)"
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
  body="$(printf '%s\n\n%s\n' "$marker" "$(cat "$md")")"

  # Find a prior agent comment by marker. Lookup failures surface (no
  # silent fallthrough to a duplicate post); head -n1 keeps one id deterministically.
  existing="$(gh api "repos/$repo/issues/$num/comments" --paginate \
    --jq "map(select(.body | startswith(\"$marker\"))) | .[0].id // empty" | head -n1)"

  if [ -n "$existing" ]; then
    gh api -X PATCH "repos/$repo/issues/comments/$existing" -f body="$body" >/dev/null
    echo "updated $label review comment ($existing) on $repo#$num"
  else
    gh pr comment "$num" --body "$body" >/dev/null
    echo "posted $label review comment on $repo#$num"
  fi
}

cmd_check() {
  bun run typecheck
  bun test
}

main() {
  local sub="${1:-}"
  [ "$#" -gt 0 ] && shift || true
  case "$sub" in
    target)  cmd_target "$@";;
    diff)    cmd_diff "$@";;
    files)   cmd_files "$@";;
    comment) cmd_comment "$@";;
    check)   cmd_check "$@";;
    ""|-h|--help) usage;;
    *) echo "unknown subcommand: $sub" >&2; usage >&2; return 2;;
  esac
}

main "$@"
