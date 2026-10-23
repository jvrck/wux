---
name: Feature
about: Propose one well-specified capability
title: 'feat: <action-oriented title>'
labels: enhancement
---

<!--
Write this issue so a coding agent can do the work without asking questions.
Follow the Issue Authoring Guide:
https://github.com/jvrck-labs/fspec/blob/main/docs/ISSUE_AUTHORING_GUIDE.md
One unit of work per issue. Security vulnerabilities go through SECURITY.md, not a public issue.
-->

## Summary

<!-- What capability should be added? -->

## Goal

<!-- What will users be able to do? -->

## Current State / Problem

<!-- Verified at `<sha>` (`main`, tag `<tag>`). Include relevant file and line references. -->

## Implementation Details

<!-- Specify behavior, interface, and important edge cases. -->

## Files Likely Affected

| File | Change |
| --- | --- |
| `src/...` | MODIFY: describe the change |

<!-- Command-surface changes also need docs/commands.md and CHANGELOG.md. -->

## Dependencies / Related Issues

<!-- Link related issues or state that there are none. -->

## Constraints / Non-Goals

<!-- Name the CLAUDE.md invariants this feature must keep. -->

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
