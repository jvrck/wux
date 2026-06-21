---
name: dual-review
description: Dual-review a PR or the current branch with an independent Codex reviewer and an independent Claude reviewer, post each review separately to the PR, fix the must-fix items, and re-review until both reviewers are satisfied. Stops at the human merge gate. Invoke explicitly; do not auto-run.
---

Run a **dual review** of the changes under review and drive them to a clean state. Invoke this explicitly — it posts PR comments and edits code.

The deterministic mechanics live in the shared helper `.claude/skills/dual-review/scripts/dual-review.sh` (one source of truth, also used by the Claude skill — run it from the repo root). Only the reviewer-spawning below is specific to Codex.

## 1. Resolve the target and gather the diff
Let `PR` be the first argument (a PR number) if given.
- `.claude/skills/dual-review/scripts/dual-review.sh target "$PR"` → `pr <N>` or `branch <base>...HEAD`.
- `.claude/skills/dual-review/scripts/dual-review.sh diff "$PR"` → the unified diff.
- `.claude/skills/dual-review/scripts/dual-review.sh files "$PR"` → the changed file list.

Summarize the scope before reviewing. With a PR number, comments go to that PR; otherwise print both reports.

## 2. Produce two independent reviews of the same diff
Neither review may see the other before both reports are complete.

- **Codex reviewer (you)** — review the diff yourself for correctness bugs, broken invariants (see `AGENTS.md`/`CLAUDE.md`: tmux naming `wux_<name>` with exact `=` targets, `WuxError` for expected failures, transactional run creation, ownership rules, strict arg parsing), missing/wrong tests, and scope creep. Produce must-fix / nice-to-fix buckets with file:line.
- **Claude reviewer** — prefer Wux when available so the independent reviewer has durable state, pane logs, explicit target selection, and an out-of-band completion signal.

  ```bash
  command -v wux
  wux --version
  wux remotes list
  wux status
  ```

  Use `wux --local` for local checkout review unless an explicit Wux remote/default target has been chosen and its `--cwd` is valid on that target. If running the repo from source during development, `bun run wux -- --local ...` is an equivalent local invocation.

  ```bash
  STAMP="$(date +%s)"
  RUN="claude-review-$STAMP"
  REPORT="/tmp/wux-${RUN}.md"
  SENTINEL="WUX_CLAUDE_REVIEW_${STAMP}_DONE"

  wux --local run claude --name "$RUN" --cwd "$PWD"
  wux --local send "$RUN" "Review PR ${PR:-current branch} independently. Use .claude/skills/dual-review/scripts/dual-review.sh diff ${PR:-} to inspect the same diff. Write the complete review to report file $REPORT, then print sentinel $SENTINEL. Do not edit files."
  wux --local read "$RUN" --tail 120
  wux --local status
  ```

  Poll with `wux --local read "$RUN" --tail 200` and `wux --local status` until the report file exists and the sentinel is visible in `pane.log`. Collect the report file as ground truth; do not rely only on pane scraping. For an explicit remote/default Wux target, collect the report through that same target rather than reading local `/tmp`. Stop the disposable reviewer after collection:

  ```bash
  wux --local stop "$RUN" --yes
  ```

  If Wux is unavailable or the backend cannot launch, fallback to the direct `claude -p` path and capture its output as the Claude review. Preserve reviewer independence either way.

## 3. Prepare the two PR reports
Keep the agent reports separate:
- Codex report: only the Codex review body.
- Claude report: only the Claude review body.

## 4. Post the reports
- PR target: write each report to its own temp file and run:
  - `.claude/skills/dual-review/scripts/dual-review.sh comment codex <PR#> <codex-file>`
  - `.claude/skills/dual-review/scripts/dual-review.sh comment claude <PR#> <claude-file>`
- No PR: print both reports locally.

## 5. Adjudicate and fix
Use both reviews to decide the fix list: **must-fix** (correctness/invariants/tests/scope) and **nice-to-fix** (style/simplification/efficiency). Treat agreement as strong signal. For disagreements, adjudicate with a brief rationale rather than deferring. Apply every **must-fix** in scope, then `.claude/skills/dual-review/scripts/dual-review.sh check` (`bun run typecheck` + `bun test`) and resolve failures.

## 6. Re-review
Repeat steps 2–5 on the updated diff until **both** reviews return no must-fix. Each round updates the same two PR comments.

## 7. Stop at the human merge gate
Report the final verdict. **Do NOT merge** unless the human explicitly authorizes the merge in this session.

## Conventions to enforce while fixing
Strict `tsc` (`bun run typecheck`); 2-space indent, LF, final newline; `node:` prefix for builtins; `import type` for type-only imports; `WuxError` for expected failures; no `Co-Authored-By` in commits.
