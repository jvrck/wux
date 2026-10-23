---
name: Task
about: Plan one well-scoped unit of work
title: 'feat|fix|docs|chore|test|ci: <action-oriented title>'
labels: ''
---

<!--
Write this issue so a coding agent can do the work without asking questions.
Follow the Issue Authoring Guide:
https://github.com/jvrck-labs/fspec/blob/main/docs/ISSUE_AUTHORING_GUIDE.md
One unit of work per issue. Security vulnerabilities go through SECURITY.md, not a public issue.
-->

## Summary

<!-- What should change, in one concise paragraph? -->

## Goal

<!-- What will be true when this work is complete? -->

## Current State / Problem

<!-- Verified at `<sha>` (`main`, tag `<tag>`). Include file and line references, such as `src/...` L10-L20. -->

## Implementation Details

<!-- Specify the intended approach and user-facing behavior. -->

## Files Likely Affected

| File | Change |
| --- | --- |
| `src/...` | MODIFY: describe the change |

<!-- Command-surface changes also need docs/commands.md and CHANGELOG.md. -->

## Dependencies / Related Issues

<!-- Link related issues, prerequisites, or state that there are none. -->

## Constraints / Non-Goals

<!-- Name the CLAUDE.md invariants this change must keep. -->

## Acceptance Criteria

- [ ] Describe an observable outcome.

## Verification

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun test test/<file>.test.ts
bun run wux -- <command>
```

<!-- tmux-dependent tests skip when tmux is absent. -->
