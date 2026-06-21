---
name: dual-review
description: Dual-review a PR or the current branch with an independent Claude reviewer and an independent Codex reviewer, post each review separately to the PR, fix the must-fix items, and re-review until both reviewers are satisfied. Stops at the human merge gate.
argument-hint: "[PR# | branch]  (defaults to current branch vs the base branch)"
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Write, Agent, mcp__codex__codex
---

Run a **dual review** of the changes under review and drive them to a clean state. This skill is explicit-only (`/dual-review`); it posts PR comments and edits code, so it never auto-triggers.

The deterministic mechanics (resolving the target, emitting the diff, posting per-agent review comments, running checks) live in the shared helper `${CLAUDE_SKILL_DIR}/scripts/dual-review.sh`. Only the reviewer-spawning below is specific to Claude Code.

## 1. Resolve the target and gather the diff
- `${CLAUDE_SKILL_DIR}/scripts/dual-review.sh target "$1"` → `pr <N>` or `branch <base>...HEAD`.
- `${CLAUDE_SKILL_DIR}/scripts/dual-review.sh diff "$1"` → the unified diff under review.
- `${CLAUDE_SKILL_DIR}/scripts/dual-review.sh files "$1"` → the changed file list.

Summarize the scope (files, intent) before reviewing. If `$1` is a PR number, all PR comments go to that PR; otherwise there is no PR and you print both reports instead.

## 2. Launch two reviewers in parallel — independently
Both reviewers see the **same diff** and neither sees the other's findings before both reports are complete. Start both reviewers before reading either report; when using Wux, start the Wux reviewer session alongside the Agent-tool reviewer, then poll the Wux result.

- **Claude reviewer** — via the **Agent** tool (`general-purpose`). Brief: review this diff for correctness bugs, broken invariants (read `AGENTS.md` and `CLAUDE.md` for the repo's invariants), missing or wrong tests, and scope creep beyond the linked issue. Return findings bucketed must-fix / nice-to-fix, each with file:line and a one-line rationale.
- **Codex reviewer** — prefer Wux when available so the independent reviewer has durable state, pane logs, explicit target selection, and an out-of-band completion signal.

  ```bash
  command -v wux
  wux --version
  wux remotes list
  wux status
  ```

  Use `wux --local` for local checkout review unless an explicit Wux remote/default target has been chosen and its `--cwd` is valid on that target. If running the repo from source during development, `bun run wux -- --local ...` is an equivalent local invocation.

  ```bash
  STAMP="$(date +%s)"
  RUN="codex-review-$STAMP"
  REPORT="/tmp/wux-${RUN}.md"
  SENTINEL="WUX_CODEX_REVIEW_${STAMP}_DONE"

  wux --local run codex --name "$RUN" --cwd "$PWD"
  wux --local send "$RUN" "Review PR ${1:-current branch} independently. Use ${CLAUDE_SKILL_DIR}/scripts/dual-review.sh diff ${1:-} to inspect the same diff. Write the complete review to report file $REPORT, then print sentinel $SENTINEL. Do not edit files."
  wux --local read "$RUN" --tail 120
  wux --local status
  ```

  Poll with `wux --local read "$RUN" --tail 200` and `wux --local status` until the report file exists and the sentinel is visible in `pane.log`. Collect the report file as ground truth; do not rely only on pane scraping. For an explicit remote/default Wux target, collect the report through that same target rather than reading local `/tmp`. Stop the disposable reviewer after collection:

  ```bash
  wux --local stop "$RUN" --yes
  ```

  If Wux is unavailable or the Codex backend cannot launch, fallback to **`mcp__codex__codex`**. Pass the **full diff** plus the key invariants inline (Codex has no repo context by default): tmux session naming (`wux_<name>`, exact `=` targets), `WuxError` for expected failures, transactional run creation, ownership rules, strict arg parsing. Ask for the same must-fix / nice-to-fix buckets with file:line.

## 3. Prepare the two PR reports
Keep the agent reports separate:
- Claude report: only the Claude review body.
- Codex report: only the Codex review body.

## 4. Post the reports
- PR target: write each report to its own temp file and run:
  - `${CLAUDE_SKILL_DIR}/scripts/dual-review.sh comment claude <PR#> <claude-file>`
  - `${CLAUDE_SKILL_DIR}/scripts/dual-review.sh comment codex <PR#> <codex-file>`
- No PR: print both reports locally.

## 5. Adjudicate and fix
Use both reviews to decide the fix list:
- **must-fix** — correctness, broken invariants, missing tests, out-of-scope changes.
- **nice-to-fix** — style, simplification, reuse, minor efficiency.
Treat agreement as strong signal. For disagreements, adjudicate with a brief rationale and put your decision in the right bucket — do not just defer to either reviewer. Apply every **must-fix** item, staying within the linked issue's scope. Then run `${CLAUDE_SKILL_DIR}/scripts/dual-review.sh check` (`bun run typecheck` + `bun test`) and resolve any failures.

## 6. Re-review
Re-run step 2 on the updated diff, then 3–5. Repeat until **both** reviewers return no must-fix findings. Each round updates the same two PR comments.

## 7. Stop at the human merge gate
Report the final verdict (clean, ready for human merge approval). **Do NOT merge** unless the human explicitly authorizes the merge in this session. "Run dual review" is not merge authorization.

## Conventions to enforce while fixing
Strict `tsc` (`bun run typecheck`); 2-space indent, LF, final newline; `node:` prefix for builtins; `import type` for type-only imports; `WuxError` for expected user-facing failures; no `Co-Authored-By` in commits.
