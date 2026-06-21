# Agent Readiness Conventions

This page documents conventions for agents and operators that compose Wux with
ordinary shell tools. Wux owns the stream and signal; it does not own the
notifier, the output artifact, or the worker's proof of work.

## Drive → Wait → Result → Branch

The canonical autonomous loop drives a worker, blocks until the turn settles,
collects a typed result, then branches on it — without hand-rolling
`events.jsonl` parsing or sentinel greps. Each verb owns one job: `send` drives,
`wait` blocks, `result` collects, the operator branches.

```bash
# 1. drive
wux send job7 "implement the change, then say DONE"

# 2. wait + 3. collect in one call (wait blocks; --result inlines the envelope)
ENV="$(wux wait job7 --idle 30s --json --result)"

# 4. branch on the typed envelope
OUTCOME="$(printf '%s' "$ENV" | jq -r .result.outcome)"
case "$OUTCOME" in
  done)
    MSG="$(printf '%s' "$ENV" | jq -r '.result.lastAssistantMessage // empty')"
    # ground truth is yours to collect — follow the pointers, don't trust the message:
    EVENTS="$(printf '%s' "$ENV" | jq -r .result.eventsPath)"
    git -C "$REPO" status --short        # or gh pr view, test runs, file checks
    ;;
  blocked)  wux attach job7 ;;            # awaiting approval — needs a human
  timeout|unknown) wux read job7 --tail 80 ;;  # inspect, then decide
esac
```

A standalone snapshot is the same envelope without blocking:

```bash
wux result job7 --json | jq '{outcome, completedVia, lastAssistantMessage}'
```

`result` answers *what did it produce?*; `wait` answers *did it finish?*; `read`
returns a labelled pane scrape. The envelope carries `outcome`, `completedVia`,
and (for `claude`/`codex`) the worker's `lastAssistantMessage`/`turnId`, plus
`runDir`/`paneLogPath`/`eventsPath`/`sentinelPath` **pointers**. Those pointers
are the boundary: wux owns the schema, you own the ground truth. There are no
git/gh/PR/test connectors — `lastAssistantMessage` is a hint to branch on, never
proof. Confirm real output through `git`, `gh`, files, or test runs you drive
yourself, exactly as with the sentinel practice below.

## Operator boot-state guide

Before a `claude`/`codex` worker can take a task, it usually passes through a
backend-specific **boot/approval state**. An autonomous operator that sends task
text into that state can stall the run or quit the session. Inspect the launch
with `read` first, clear the state explicitly, then drive the real task. These
states were all hit live in the 2026-06-08 operator eval.

Backends are interactive TUIs, not a turn API. `read` is a labelled pane scrape;
gate readiness on what the pane actually shows, never on the `send` verdict (see
[`send` ergonomics](#send-ergonomics) below).

### codex first launch

A fresh `codex` run boots into a **directory-trust modal** before it will accept
any task:

```text
Do you trust the files in this folder?
  1. Yes
  2. No
```

Clear it by sending the choice as literal text **before** any task. Confirm the
modal is gone with `read`, then send the real prompt:

```bash
wux read <run> --tail 40             # see the trust modal
wux send <run> '1'                   # 1. Yes — trust this directory
wux read <run> --tail 40             # confirm the prompt box is ready
wux send <run> 'implement the change, then say DONE'
```

Do **not** send task text while the modal is up: codex can interpret a free-form
line as `2. No` or as a quit and kill the session. Send `'1'` first.

When codex reports `permissions: YOLO mode` (visible in the boot banner), there
are no per-write approval stalls — the worker edits files without pausing for
approval, so the run will not block on a write gate. That is a property of the
launched session, not something wux grants; confirm it in the banner via `read`
rather than assuming it.

### claude first launch

A fresh `claude` run shows a welcome/init screen before the input box is live.
The input box may not be ready the instant the run is created, so an immediate
`send` can land before claude is listening. Confirm the prompt is ready with
`read` before the real `send`:

```bash
wux read <run> --tail 40             # wait for the input box / prompt, not the splash
wux send <run> 'implement the change, then say DONE'
```

If claude is launched with `⏵⏵ bypass permissions` mode, it will not pause for
per-tool approval; like codex YOLO mode, that is a launched-session property to
**observe** in the banner, not a wux-granted state.

### `send` ergonomics

- **Options precede the text.** The usage is
  `wux send <run> [--force-owner] [--json] <text>`. `--json` and `--force-owner`
  must come *before* the literal text — `wux send <run> --json '...'`, never
  `wux send <run> '...' --json` (a trailing `--json` is rejected with a bad-args
  error). The same ordering holds for the MCP `send` tool's option fields.
- **Use `--` for flag-like text.** If the literal text starts with a dash (an
  option-like value), put `--` before it so it is treated as text, not an option:
  `wux send <run> -- '--help me'`. Without the `--` terminator, leading-dash text
  is rejected as an unknown option.
- **Gate on `wait` + ground truth, never on the send verdict.** `send` returns an
  advisory verdict — `submitted | uncertain | not-submitted` — computed by
  diffing the pane around the keystroke. It answers *did the keystroke land?*, not
  *did the turn finish?* In the eval, **every** send under-claimed (reported a
  non-`submitted` verdict) while actually succeeding. Treat a non-`submitted`
  verdict as a warning worth a `read`, not a failure, and decide completion from
  `wux wait` plus ground truth (`git`, `gh`, files, the result envelope), exactly
  as in [Drive → Wait → Result → Branch](#drive--wait--result--branch).

### Recovery

If `read` shows a modal, approval prompt, or login/auth state at any point —
not just at boot — handle it explicitly:

- Clear a known modal with the documented choice (e.g. `wux send <run> '1'` for
  the codex trust modal), then re-`read` to confirm the prompt is back.
- For an approval or login state that needs a human, surface it and
  `wux attach <run>` for interactive takeover; do not guess credentials.
- **Never send task text into an unknown modal.** A free-form line can be read as
  a menu choice and quit the session. When in doubt, `read` and decide.

## Composed Notify Pattern

Use `wux wait` to observe that a run settled, then compose whatever notification
tool belongs to your environment:

```bash
# canonical: wux owns the signal, the notifier is yours
wux wait job7 --idle 30s && ntfy publish my-topic "job7 done"

# webhook variant
wux wait job7 --idle 30s && curl -fsS -d "job7 done" https://hooks.example/...

# desktop variant
wux wait job7 --idle 30s && notify-send "wux" "job7 done"
```

Plainly: wux owns the signal, not the notifier. A `wux wait --notify ...` or
`wux wait --on-idle ...` convenience flag is out of scope because a flag that
knows a notifier crosses the compose-don't-connect line. Even a generic
run-a-user-command-on-idle form remains a post-launch open decision, not part of
this build.

The internal `wux notify` helper route used by backend hooks is not a human
notification command. It is a short-lived file-drop helper for Claude/Codex hook
payloads and should not be treated as a notifier connector.

## Sentinel Practice

A sentinel is a cooperative marker printed by the worker and later found in the
run's `pane.log`. Make it unique per loop so an old marker cannot satisfy a new
iteration. `WUX_DONE` is an illustrative default only; it is never a reserved Wux constant,
never a binary verb, and never proof by itself.

```bash
# worker, at the end of loop 7
echo "WUX_DONE job7#7"

# consumer
PANE_LOG="$(wux read job7 --json | jq -r .paneLogPath)"
timeout 600 sh -c 'until grep -m1 "WUX_DONE job7#7" "$1"; do sleep 2; done' sh "$PANE_LOG"
```

Sentinels carry four required caveats:

1. They are cooperative and best-effort. The worker can forget to print the
   marker, stall on an approval gate, crash, or keep thinking. Absence of the
   marker means unknown, never failed and never done.
2. They need a timeout and a human attach fallback. Never block forever on a
   marker that may never appear; use `wux attach <run>` when the run needs human
   inspection.
3. They are not a Wux guarantee. A marker answers only a weak slice of "what did
   it produce?" Ground truth from `git`, `gh`, files, or other durable artifacts
   owns real output collection.
4. They are separate from `wux wait`'s internal sentinel rung. The cooperative
   `WUX_DONE` marker is something you grep from `pane.log`; Wux will not grep
   that marker for you. `wux wait` resolves hook signal > `turn-complete`
   sentinel file > frame-hash quiescence, with tmux session-exists liveness as
   the backstop. That internal file can feed `completedVia: "sentinel"`, but it
   does not describe task output.

   For shell runs, frame-hash quiescence is process-aware: once the pane has been
   byte-static for the idle window, `wux wait` confirms via tmux
   `#{pane_pid}`/`#{pane_current_command}` that the pane's foreground process is
   the shell at its prompt before declaring `done`. A silent-but-busy run
   (`yes > /dev/null`, a compute writing only to a file) therefore resolves
   `timeout`, not a false `done`. `completedVia: "quiescence"` for shell proves
   pane silence **and** an idle prompt — never that the task succeeded.

There is no `wux sentinel` verb and no notifier-aware flag. Keep the marker
cooperative, unique, timeout-bound, and paired with ground-truth collection.
