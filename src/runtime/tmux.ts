import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WuxError } from "./errors";
import { withLock } from "./lock";
import { processCommandName, runInteractiveProcess, runProcess, type ProcessResult } from "./process";
import { stateRoot } from "./state";

export type TmuxRunner = (args: string[]) => Promise<ProcessResult>;

// Generous in-memory scrollback so a human who attaches a wux session can read
// back long agent turns in copy-mode. tmux's 2000-line default loses the oldest
// output from the pane (the pane.log file still has it, but that is not what an
// attached human is looking at). Applied at pane creation — see createSession.
const WUX_HISTORY_LIMIT = "50000";
// wux-owned tmux config, written under the state root (NEVER the operator's
// ~/.tmux.conf). Passed as `tmux -f <conf>` so a FRESH tmux server starts with
// the generous history-limit; on an already-running server tmux ignores -f (it
// reads a config file only at server start), so createSession also applies the
// limit directly. See createSession for the full timing rationale.
const WUX_TMUX_CONF_NAME = "tmux.conf";
// Cross-process lock guarding the brief window where createSession mutates the
// SHARED global tmux history-limit. All `wux run`s point at one tmux server, and
// wux is driven by workers that launch many runs at once; without this the
// read→elevate→create→restore of the single global races (operator's global left
// elevated, or a pane created before its elevation lands). Lives under the state
// root, next to the conf. See createSession.
const WUX_GLOBAL_LOCK_NAME = "global-history-limit.lock";
// Opt-in env flag for tmux mouse mode. Off by default because `mouse on` changes
// native terminal click-drag selection (copy then needs Shift/Option), which
// surprises operators who copy by mouse. Strict "1" match, mirroring the env-flag
// idioms elsewhere in wux.
const WUX_TMUX_MOUSE_ENV = "WUX_TMUX_MOUSE";

export function tmuxSessionName(runName: string): string {
  return `wux_${runName}`;
}

export async function requireTmux(runner: TmuxRunner = runProcess): Promise<void> {
  const result = await runner(["tmux", "-V"]);
  if (result.code !== 0) {
    throw new WuxError(`tmux is required but was not found: ${result.stderr || result.stdout}`.trim());
  }
}

export async function hasSession(session: string): Promise<boolean> {
  const result = await runProcess(["tmux", "has-session", "-t", exactTarget(session)]);
  return result.code === 0;
}

function exactTarget(session: string): string {
  return `=${session}`;
}

function exactPaneTarget(session: string): string {
  return `=${session}:`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\''")}'`;
}

// The wux-owned tmux config path under the state root. Lives beside `runs/`,
// never in the operator's home or a repo.
function wuxTmuxConfPath(env: NodeJS.ProcessEnv): string {
  return join(stateRoot(env), WUX_TMUX_CONF_NAME);
}

// Path to the cross-process lock that serializes the global history-limit window.
function wuxGlobalLockPath(env: NodeJS.ProcessEnv): string {
  return join(stateRoot(env), WUX_GLOBAL_LOCK_NAME);
}

// Write (idempotently) the wux-managed tmux config and return its path. It only
// sets the generous history-limit globally; mouse stays out of the file because
// it is per-session and env-gated (a file is read once at server start, so it
// cannot express the opt-in). Regenerated on every run so the shipped value
// always wins even if an older copy is on disk.
async function ensureWuxTmuxConf(env: NodeJS.ProcessEnv): Promise<string> {
  const path = wuxTmuxConfPath(env);
  const body =
    "# Managed by wux — do not edit; regenerated on each `wux run`.\n" +
    "# Generous scrollback so an attached human can read back long agent turns.\n" +
    `set-option -g history-limit ${WUX_HISTORY_LIMIT}\n`;
  await mkdir(stateRoot(env), { recursive: true });
  await writeFile(path, body, "utf8");
  return path;
}

// The operator's current global history-limit, so we can put it back exactly.
// Undefined when it cannot be read (no server yet / unexpected failure).
async function readGlobalHistoryLimit(runner: TmuxRunner): Promise<string | undefined> {
  const result = await runner(["tmux", "show-options", "-gv", "history-limit"]);
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

// Restore the operator's global history-limit: re-set a captured value, or unset
// (-u) back to tmux's compiled default when there was no baseline to capture.
async function restoreGlobalHistoryLimit(previous: string | undefined, runner: TmuxRunner): Promise<void> {
  if (previous === undefined) {
    await runner(["tmux", "set-option", "-gu", "history-limit"]);
  } else {
    await runner(["tmux", "set-option", "-g", "history-limit", previous]);
  }
}

// Set a session-scoped tmux option. Uses the exact-match `=<session>:` target
// form: `set-option`/`show-options` reject the bare `=<session>` form that
// has-session accepts, and the colon form stays exact-match (no prefix bleed).
async function setSessionOption(session: string, name: string, value: string, runner: TmuxRunner): Promise<void> {
  const result = await runner(["tmux", "set-option", "-t", exactPaneTarget(session), name, value]);
  if (result.code !== 0) {
    throw new WuxError(`failed to set ${name} on ${session}: ${result.stderr || result.stdout}`.trim());
  }
}

export async function createSession(options: {
  session: string;
  cwd: string;
  command: string[];
  logPath: string;
  env?: NodeJS.ProcessEnv;
  runner?: TmuxRunner;
}): Promise<void> {
  const env = options.env ?? process.env;
  const runner = options.runner ?? runProcess;

  try {
    const cwdStat = await stat(options.cwd);
    if (!cwdStat.isDirectory()) throw new WuxError(`cwd is not a directory: ${options.cwd}`);
  } catch (error) {
    if (error instanceof WuxError) throw error;
    throw new WuxError(`cwd does not exist: ${options.cwd}`);
  }

  await requireTmux(runner);

  // Make wux sessions human-scrollable on attach. tmux fixes a pane's scrollback
  // buffer when the pane is created and reads a `-f` config only at server start,
  // so on an already-running tmux server the conf alone cannot grow the INITIAL
  // pane. To make the generous history-limit effective on that first pane without
  // permanently changing the operator's global, elevate the global limit only for
  // the new-session call, restore it immediately (before==after), then pin the
  // limit at session scope so it survives the restore, is readable via
  // `show-options -t <session>`, and applies to any later panes/windows.
  //
  // The global is a SINGLE shared value on the one tmux server, so concurrent
  // `wux run`s would otherwise race this read-elevate-create-restore: one run can
  // read another's elevated 50000 as its "baseline" (leaving the operator's
  // global stuck at 50000), or restore the default before another's new-session
  // lands (creating that pane at the un-elevated limit). Hold a cross-process lock
  // across the whole window — read → elevate → create → restore — so the sequence
  // is atomic between runs. Everything that does NOT touch the global (session
  // pin, mouse, pipe-pane) stays OUTSIDE the lock to keep the held window tiny.
  const conf = await ensureWuxTmuxConf(env);
  const create = await withLock(wuxGlobalLockPath(env), async () => {
    const previousGlobal = await readGlobalHistoryLimit(runner);
    const elevate = await runner(["tmux", "set-option", "-g", "history-limit", WUX_HISTORY_LIMIT]);
    // Surface a failed elevation only when a tmux server is already running
    // (previousGlobal was readable). With NO server yet, the elevation can't
    // apply and is not needed: new-session below starts the server, which reads
    // the wux `-f conf` and gives the first pane the generous history-limit.
    // (Throwing unconditionally broke the first `wux run` on a serverless host.)
    if (elevate.code !== 0 && previousGlobal !== undefined) {
      throw new WuxError(`failed to elevate tmux history-limit: ${elevate.stderr || elevate.stdout}`.trim());
    }
    try {
      return await runner([
        "tmux",
        "-f",
        conf,
        "new-session",
        "-d",
        "-s",
        options.session,
        "-c",
        options.cwd,
        ...options.command,
      ]);
    } finally {
      // Restore inside the lock so the operator's global is back to baseline
      // before any other run reads it; the lock's own finally then frees it.
      await restoreGlobalHistoryLimit(previousGlobal, runner);
    }
  });
  if (create.code !== 0) {
    throw new WuxError(`failed to create tmux session ${options.session}: ${create.stderr || create.stdout}`.trim());
  }

  try {
    // Pin the generous scrollback at session scope (outlives the global restore,
    // visible to show-options, and inherited by later panes/windows).
    await setSessionOption(options.session, "history-limit", WUX_HISTORY_LIMIT, runner);
    // Mouse is contentious (it changes native click-drag selection), so it is
    // strictly opt-in and applied only at session scope — never globally and
    // never to the operator's ~/.tmux.conf.
    if (env[WUX_TMUX_MOUSE_ENV] === "1") {
      await setSessionOption(options.session, "mouse", "on", runner);
    }

    const pipe = await runner([
      "tmux",
      "pipe-pane",
      "-o",
      "-t",
      exactPaneTarget(options.session),
      `cat >> ${shellQuote(options.logPath)}`,
    ]);
    if (pipe.code !== 0) {
      throw new WuxError(`failed to start pane logging: ${pipe.stderr || pipe.stdout}`.trim());
    }
  } catch (error) {
    await killSession(options.session, runner).catch(() => undefined);
    throw error;
  }
}

export async function killSession(session: string, runner: TmuxRunner = runProcess): Promise<void> {
  const result = await runner(["tmux", "kill-session", "-t", exactTarget(session)]);
  if (result.code !== 0) {
    throw new WuxError(`failed to stop ${session}: ${result.stderr || result.stdout}`.trim());
  }
}

// Honest-submit verdict. This is a HEURISTIC over the pane, not an end-of-turn
// signal: it answers "did the prompt submit", not "did the turn finish".
export type Submission = "submitted" | "uncertain" | "not-submitted";

export interface SubmitResult {
  submission: Submission;
  retried: boolean;
}

export interface SendLiteralOptions {
  // Backend of the target run; `shell` accepts Enter unconditionally so it is
  // always classified `submitted`. Typed as string to preserve the layering
  // invariant (runtime/ must not import from commands/).
  backend?: string;
  // Injectable tmux runner + pane capture so the path is unit-testable without
  // a live backend TUI.
  runner?: TmuxRunner;
  capture?: (session: string, tail: number) => Promise<string>;
  // Base settle between events (type→submit, submit→re-observe). On a
  // readiness-gated backend this is scaled up for large/multi-line pastes so the
  // TUI has time to render them; see `scaledSettleMs`.
  settleMs?: number;
  // Readiness-gate overrides. `readiness` forces the pre-submit gate on/off
  // (default: the `WUX_SEND_READINESS` env flag — on unless set to "0"); the rest
  // tune the bounded quiescence probe. Exposed mainly so the gated path is
  // deterministically unit-testable without a live backend TUI (inject `sleep`
  // and `now` to drive the bound without real time).
  readiness?: boolean;
  probeIntervalMs?: number;
  maxProbeSamples?: number;
  stableSamples?: number;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

const SUBMIT_SETTLE_MS = 200;
const CLASSIFY_TAIL = 50;
// Prompt/composer markers common across interactive backends (Claude/Codex draw
// the input line with one of these). Best-effort, never a single hard-coded spinner.
const COMPOSER_LINE_RE = /^\s*(?:[│|╎┃┆┊]\s*)?[>›❯❱]/;
// Consume the ESC introducer so a styled CSI sequence is fully stripped, not
// left as a stray ESC that defeats the anchored composer match.
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const STRAY_ESC_RE = /\x1b/g;
// Minimum length for a prefix/continuation match, so short tokens do not match
// incidental substrings of composer placeholder chrome.
const MIN_COMPOSER_SIGNATURE = 4;
// Marker prefix (+ optional trailing space) stripped to read the composer head.
const COMPOSER_MARKER_RE = new RegExp(`${COMPOSER_LINE_RE.source}\\s?`);

// Cross-backend "turn in flight" signal. Both Claude and Codex print "esc to
// interrupt" in the status row while a turn is running (Claude: "· esc to
// interrupt"; Codex: "Working (Ns • esc to interrupt)") and never at rest —
// captured from real panes. This is the reliable busy anchor: a spinner glyph
// alone is too variable and Codex's elapsed timer ticks per-second, so two
// sub-second captures can be byte-identical while busy; the anchor catches that.
// Best-effort, never a single hard-coded spinner; only ever scoped OFF the
// composer line(s) holding the sent text (see classifyComposerReady).
const BUSY_INDICATOR_RE = /esc to interrupt/i;

// Bounded pre-submit readiness gate (claude/codex). The pane is sampled at a
// FIXED short interval until it is observed at-rest across K consecutive frames,
// then the submit fires; the whole gate is hard-capped at a SMALL fixed number of
// samples (~1s) so it rides out the post-type redraw race and a brief settle
// WITHOUT becoming an unbounded/adaptive waiter (the deferred liveness-probe
// engine). It deliberately does NOT wait out a multi-second turn: a send into a
// sustained-busy pane reports an honest non-submitted verdict, and the caller's
// wait-then-send doctrine handles that case.
const READINESS_PROBE_INTERVAL_MS = 150;
const READINESS_STABLE_SAMPLES = 2;
const READINESS_MAX_SAMPLES = 8;
// Large/multi-line pastes take the TUI longer to render into the composer before
// Enter is safe. Add a bounded, payload-scaled cushion onto the base settle.
const SETTLE_BYTES_PER_STEP = 256;
const SETTLE_STEP_MS = 40;
const SETTLE_MAX_EXTRA_MS = 1_500;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "").replace(STRAY_ESC_RE, "");
}

// Whether the pre-submit readiness gate is active. Default-ON; the kill-switch
// `WUX_SEND_READINESS=0` reverts to the legacy blind type+Enter behaviour in the
// same release. Strict "0" match (unset/empty/anything-else = on) so the revert
// is one exact sentinel, not truthiness guessing.
function readinessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WUX_SEND_READINESS !== "0";
}

// Probe only known interactive Ink backends. shell has its own fast-path; an
// unknown/future backend falls through to the legacy path so it never hangs on a
// pane that is never "composer-ready".
function isGatedBackend(backend: string | undefined): boolean {
  return backend === "claude" || backend === "codex";
}

// Bounded, payload-scaled settle. Pure function of the literal so it is unit
// testable with zero I/O.
function scaledSettleMs(base: number, text: string): number {
  const bytes = Buffer.byteLength(text);
  const extra = Math.min(SETTLE_MAX_EXTRA_MS, Math.floor(bytes / SETTLE_BYTES_PER_STEP) * SETTLE_STEP_MS);
  return base + extra;
}

// Trimmed, non-empty lines of the sent text — the per-line "needles" the composer
// is expected to hold. Shared by the submit and readiness classifiers.
function toNeedles(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface ComposerAnchor {
  // "held": the full sent text sits on contiguous composer line(s).
  // "partial": the first sent line is anchored but a continuation is ambiguous.
  // "absent": the sent text is not anchored on any composer line.
  presence: "held" | "partial" | "absent";
  // Inclusive line-index range (into the stripped frame's lines) spanned by the
  // anchored text, used to scope the busy-indicator check OFF the composer's own
  // bytes. Undefined when absent.
  start?: number;
  end?: number;
}

// Locate the sent text on a composer line, scanning bottom-up. Anchoring on the
// sent text (not the bottom-most marker) is robust to user content that itself
// begins with a marker glyph (markdown blockquotes, pasted shell prompts). Pure;
// shared by classifySubmission (text-present ⇒ not-submitted) and
// classifyComposerReady (text-present + at-rest ⇒ ready).
function composerTextAnchor(afterClean: string, needles: string[]): ComposerAnchor {
  const lines = afterClean.split("\n");
  const firstWant = needles[0];
  const headMatchesFirst = (head: string): boolean => {
    if (head.length === 0) return false;
    if (head === firstWant) return true;
    // width-truncated/wrapped: the visible head is a leading slice of the sent line
    if (head.length >= MIN_COMPOSER_SIGNATURE && firstWant.startsWith(head)) return true;
    // trailing cursor/glyph after the sent line
    if (firstWant.length >= MIN_COMPOSER_SIGNATURE && head.startsWith(firstWant)) return true;
    // pre-existing draft text before the appended prompt: the sent line sits at the
    // end of the head on a word boundary, so short prompts like "hi" match "draft hi"
    // but not the tail of an unrelated word like "graphi".
    if (head.endsWith(firstWant)) {
      const boundary = head.length - firstWant.length;
      return boundary === 0 || /\s/.test(head.charAt(boundary - 1));
    }
    return false;
  };
  const continuationMatches = (want: string, line: string | undefined): boolean => {
    if (line === undefined) return false;
    const trimmed = line.trim();
    const stripped = line.replace(COMPOSER_MARKER_RE, "").trim();
    // Continuation lines keep their own leading glyphs (user content); tolerate
    // exact, marker-stripped, substring, and width-truncated (prefix) forms.
    return (
      trimmed === want ||
      stripped === want ||
      trimmed.includes(want) ||
      (trimmed.length >= MIN_COMPOSER_SIGNATURE && want.startsWith(trimmed)) ||
      (stripped.length >= MIN_COMPOSER_SIGNATURE && want.startsWith(stripped))
    );
  };
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!COMPOSER_LINE_RE.test(lines[i])) continue;
    if (!headMatchesFirst(lines[i].replace(COMPOSER_MARKER_RE, "").trim())) continue;
    const end = i + needles.length - 1;
    // Transcript-echo guard: a SUBMITTED message is re-rendered ABOVE the live
    // composer with the same prompt-marker prefix (claude shows the user's turn as
    // "❯ <text>"). Treat this match as transcript history (text has LEFT the
    // composer) only when a SEPARATE live composer head sits below it: a
    // composer-marker line that either (a) appears AFTER a non-composer line — a
    // blank, a rule, or response output separates the transcript from the live
    // composer — or (b) is an EMPTY cleared composer head. A composer-marker line
    // CONTIGUOUS with the matched region that still carries text is a visual WRAP /
    // continuation of the same composer, not a separate head, so it does not count
    // (else a wrapped strand whose wrap row begins with > / › / ❯ / ❱ would be
    // misread as submitted — a dangerous false success on a real strand).
    let sawGap = false;
    let separateComposerBelow = false;
    for (let j = end + 1; j < lines.length; j += 1) {
      if (!COMPOSER_LINE_RE.test(lines[j])) {
        sawGap = true;
        continue;
      }
      const headBelow = lines[j].replace(COMPOSER_MARKER_RE, "").trim();
      if (sawGap || headBelow.length === 0) {
        separateComposerBelow = true;
        break;
      }
    }
    if (separateComposerBelow) return { presence: "absent" };
    const confirmed = needles.every((want, offset) => offset === 0 || continuationMatches(want, lines[i + offset]));
    return { presence: confirmed ? "held" : "partial", start: i, end };
  }
  return { presence: "absent" };
}

// Pure classifier: takes captured frames and returns the verdict with no I/O.
// Tests drive this with fixtures — do not reproduce live composer states.
export function classifySubmission(before: string, after: string, text: string, backend?: string): Submission {
  if (backend === "shell") return "submitted";

  const needles = toNeedles(text);
  if (needles.length === 0) return "uncertain";

  const afterClean = stripAnsi(after);
  // An empty/unobservable post-submit frame (e.g. capture failed) cannot be
  // honestly called submitted - report uncertain rather than a bare success.
  if (afterClean.trim().length === 0) return "uncertain";

  // If the sent text is anchored on a composer line it has NOT submitted; an
  // ambiguous continuation stays honest with "uncertain" rather than a clean
  // success.
  const anchor = composerTextAnchor(afterClean, needles);
  if (anchor.presence === "held") return "not-submitted";
  if (anchor.presence === "partial") return "uncertain";

  const stillPresent = needles.some((needle) => afterClean.includes(needle));
  if (!stillPresent) return "submitted";

  // Text lingers in the frame but not on a composer line. Without a usable
  // baseline (before-capture failed/empty) we cannot honestly say the frame
  // advanced, so stay uncertain rather than risk a false success.
  const beforeClean = stripAnsi(before);
  if (beforeClean.trim().length === 0) return "uncertain";
  return beforeClean !== afterClean ? "submitted" : "uncertain";
}

// Readiness verdict for the pre-submit gate. Distinct from classifySubmission
// (text-present ⇒ strand) and COMPOSER_LINE_RE (bare marker-presence): it answers
// "is it safe to press Enter now?".
export type ComposerReadiness = "ready" | "busy" | "unknown";

// Normalize a captured frame for the byte-static comparison: strip ANSI
// (defensive — capturePane uses `-p`, already escape-free) and trailing
// whitespace per line. No cursor-cell masking: `-p` does not render the terminal
// cursor as a glyph, so masking would be dead code.
function normalizeReadyFrame(frame: string): string {
  return stripAnsi(frame)
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n+$/g, "");
}

// Decide whether the composer is at-rest and safe to submit into, from the two
// most-recent frames (most-recent last) plus the sent text. "ready" requires all
// three: (1) the sent literal actually rendered onto a composer line — NOT bare
// marker presence, so at-rest ghost/placeholder text and the stale post-type
// redraw frame are never "ready"; (2) no busy indicator OFF the composer line(s)
// — so typed text or scrollback containing "esc to interrupt" cannot pin a false
// busy; (3) the two frames are byte-static — so a streaming/redrawing pane is not
// "ready". Pure; tests drive it with fixtures captured off real claude/codex panes.
export function classifyComposerReady(frames: string[], text: string): ComposerReadiness {
  if (frames.length < 2) return "unknown";
  const last = normalizeReadyFrame(frames[frames.length - 1]);
  const prev = normalizeReadyFrame(frames[frames.length - 2]);
  if (last.trim().length === 0) return "unknown";

  const needles = toNeedles(text);
  if (needles.length === 0) return "unknown";

  // The typed literal must be fully on the composer; otherwise it is still
  // rendering (redraw race), still showing ghost text, or already gone — not the
  // moment to submit.
  const anchor = composerTextAnchor(last, needles);
  if (anchor.presence !== "held") return "unknown";

  // Busy check scoped OFF the composer's own line(s): the indicator lives in the
  // status row, so the literal sitting in the composer cannot trip it. The span is
  // estimated as one row per sent line; a sent line that visually WRAPS occupies
  // more rows, so the estimate can be short — but that only over-checks rows for
  // the busy indicator (a bounded, conservative false-busy that withholds the
  // submit), never under-checks into a false "ready" that would strand.
  const lines = last.split("\n");
  const start = anchor.start ?? -1;
  const end = anchor.end ?? -1;
  const busyOutsideComposer = lines.some((line, index) => {
    if (index >= start && index <= end) return false;
    return BUSY_INDICATOR_RE.test(line);
  });
  if (busyOutsideComposer) return "busy";

  // Still changing between the two most-recent frames → streaming/redrawing.
  if (last !== prev) return "busy";

  return "ready";
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendKeysOnce(runner: TmuxRunner, target: string, session: string, keys: string[], action: string): Promise<void> {
  const result = await runner(["tmux", "send-keys", "-t", target, ...keys]);
  if (result.code !== 0) {
    throw new WuxError(`failed to ${action} ${session}: ${result.stderr || result.stdout}`.trim());
  }
}

// Interrupt the pane's current turn with a single C-c. C-c is a key NAME (sent
// WITHOUT -l) so tmux delivers an interrupt rather than literal text. Narrowly
// interrupt-only — there is deliberately no arbitrary-key send surface.
export async function interruptSession(session: string, runner: TmuxRunner = runProcess): Promise<void> {
  await sendKeysOnce(runner, exactPaneTarget(session), session, ["C-c"], "interrupt");
}

interface ReadinessProbeOptions {
  intervalMs: number;
  maxSamples: number;
  stableSamples: number;
  sleep: (ms: number) => Promise<void>;
}

// Bounded pre-submit quiescence wait. Sample the pane at a FIXED interval until it
// is observed at-rest (classifyComposerReady against the sent text) across
// `stableSamples` consecutive frames, or the small fixed sample budget is spent.
// Returns the last readiness so the caller can stay honest. Mirrors wait.ts
// frame-quiescence on a small, hard-bounded scale — the bound is the sample COUNT
// (no wall-clock, no growth), so it is deterministic and never an adaptive waiter.
async function waitForComposerReady(
  probe: () => Promise<string>,
  text: string,
  opts: ReadinessProbeOptions,
): Promise<ComposerReadiness> {
  const need = Math.max(1, opts.stableSamples);
  let prev = await probe();
  let consecutiveReady = 0;
  let sawBusy = false;
  let last: ComposerReadiness = "unknown";
  for (let sample = 1; sample < Math.max(2, opts.maxSamples); sample += 1) {
    await opts.sleep(opts.intervalMs);
    const current = await probe();
    last = classifyComposerReady([prev, current], text);
    prev = current;
    if (last === "ready") {
      consecutiveReady += 1;
      if (consecutiveReady >= need) return "ready";
    } else {
      consecutiveReady = 0;
      if (last === "busy") sawBusy = true;
    }
  }
  // Budget spent without a stable "ready". Once the pane was positively observed
  // busy, report "busy" so the caller withholds the submit — a later "unknown"
  // sample (the indicator scrolled off, or the text anchor was momentarily lost)
  // must not re-enable a no-op Enter into a still-busy pane.
  return sawBusy ? "busy" : last;
}

export async function sendLiteral(session: string, text: string, options: SendLiteralOptions = {}): Promise<SubmitResult> {
  const runner = options.runner ?? runProcess;
  const capture = options.capture ?? capturePane;
  const target = exactPaneTarget(session);
  const backend = options.backend;
  const sleep = options.sleep ?? delay;
  const baseSettleMs = options.settleMs ?? SUBMIT_SETTLE_MS;

  // The shell backend accepts Enter unconditionally — keep the fast path: type +
  // Enter, no capture, always "submitted".
  if (backend === "shell") {
    await sendKeysOnce(runner, target, session, ["-l", text], "send text to");
    await sendKeysOnce(runner, target, session, ["Enter"], "submit text to");
    return { submission: "submitted", retried: false };
  }

  const env = options.env ?? process.env;
  // Gate only known interactive backends, and only when the kill-switch leaves the
  // readiness path on; everything else falls through to the legacy blind path.
  const gated = (options.readiness ?? readinessEnabled(env)) && isGatedBackend(backend);
  const settleMs = gated ? scaledSettleMs(baseSettleMs, text) : baseSettleMs;
  const probeOpts: ReadinessProbeOptions = {
    intervalMs: options.probeIntervalMs ?? READINESS_PROBE_INTERVAL_MS,
    maxSamples: options.maxProbeSamples ?? READINESS_MAX_SAMPLES,
    stableSamples: options.stableSamples ?? READINESS_STABLE_SAMPLES,
    sleep,
  };
  const probe = (): Promise<string> => capture(session, CLASSIFY_TAIL).catch(() => "");

  const before = await probe();

  // Always type the literal (gate only the submit, never the type) so a deliberate
  // send to a busy pane never loses bytes. The whole literal — newlines included —
  // goes in one `-l`; a single Enter then submits it as ONE turn.
  await sendKeysOnce(runner, target, session, ["-l", text], "send text to");

  // Pre-submit readiness gate (gated backends only): wait, bounded, for the typed
  // literal to render and the pane to be at-rest before Enter. Crucially, do NOT
  // press Enter into a pane positively observed as busy — that Enter is a dropped
  // no-op that just re-strands the text (the very failure this fixes). "ready" →
  // submit (it lands); "unknown" → submit best-effort (the literal may simply have
  // rendered slowly; the honest verdict catches the outcome); "busy" → withhold the
  // submit and report the honest verdict (the literal is typed/queued — a later
  // idempotent send, or wait-then-send, lands it without losing bytes).
  let preReady: ComposerReadiness = "ready";
  if (gated) {
    preReady = await waitForComposerReady(probe, text, probeOpts);
    await sleep(settleMs);
  }

  let submission: Submission;
  let retried = false;

  if (preReady === "busy") {
    submission = classifySubmission(before, await probe(), text, backend);
  } else {
    await sendKeysOnce(runner, target, session, ["Enter"], "submit text to");
    await sleep(settleMs);
    submission = classifySubmission(before, await probe(), text, backend);

    if (submission === "not-submitted") {
      // Strand evidence: the sent text is still on a composer line, so the Enter was
      // dropped. A blind resend is a no-op on a still-busy pane: on a gated backend
      // re-confirm the pane left busy and resend only then; on the legacy path keep
      // the single blind retry. Always re-read after, so a send that landed late is
      // not reported as a stale not-submitted.
      const mayResend = gated ? (await waitForComposerReady(probe, text, probeOpts)) === "ready" : true;
      if (mayResend) {
        await sendKeysOnce(runner, target, session, ["Enter"], "submit text to");
        retried = true;
        await sleep(settleMs);
      }
      submission = classifySubmission(before, await probe(), text, backend);
    }
  }

  return { submission, retried };
}

export async function capturePane(session: string, tail: number): Promise<string> {
  const result = await runProcess(["tmux", "capture-pane", "-p", "-t", exactPaneTarget(session), "-S", `-${tail}`]);
  if (result.code !== 0) {
    throw new WuxError(`failed to read ${session}: ${result.stderr || result.stdout}`.trim());
  }

  const normalized = result.stdout.replace(/\r\n/g, "\n").replace(/\n+$/g, "");
  if (normalized.length === 0) return "";
  const lines = normalized.split("\n");
  return `${lines.slice(-tail).join("\n")}\n`;
}

// Foreground-process activity probe used to make shell quiescence honest. tmux
// reports `#{pane_pid}` (the long-lived pane shell) and `#{pane_current_command}`
// (the command currently in the pane's tty foreground). When a child command is
// running — `yes > /dev/null`, a silent file-writing compute, `sleep` — the
// foreground command is that child, not the shell, so the pane can be byte-static
// while the process is busy. We resolve the pane shell's own executable name and
// declare the pane idle ONLY when the foreground command is that shell (the
// prompt has returned). This is poll-based and short-lived: a single `tmux
// display-message` plus one `ps` per call, no daemon and no watcher.
export type PaneActivity = "idle" | "foreground-busy" | "unknown";

export interface PaneActivityProbe {
  runner?: TmuxRunner;
  commandName?: (pid: number, runner?: TmuxRunner) => Promise<string | undefined>;
}

async function displayField(runner: TmuxRunner, session: string, format: string): Promise<string | undefined> {
  const result = await runner(["tmux", "display-message", "-p", "-t", exactPaneTarget(session), "-F", format]);
  if (result.code !== 0) return undefined;
  return (result.stdout.split("\n")[0] ?? "").trim();
}

export async function paneForegroundActivity(session: string, probe: PaneActivityProbe = {}): Promise<PaneActivity> {
  const runner = probe.runner ?? runProcess;
  const commandName = probe.commandName ?? processCommandName;

  // Read pid and current command in two separate display-message calls rather
  // than one with an in-band separator. tmux escapes non-printable bytes in
  // format output (e.g. 0x1f becomes the literal "\037" on tmux 3.4 — Ubuntu's
  // build, used by GitHub-hosted runners), which silently broke a single-call
  // `#{pane_pid}<sep>#{pane_current_command}` parse and made the probe return
  // "unknown" on those runners (#138). Two single-field reads avoid any
  // separator entirely and are version-stable; the cost is one extra
  // display-message per probe (still no daemon, no watcher).
  const pidField = await displayField(runner, session, "#{pane_pid}");
  if (pidField === undefined) return "unknown";
  const panePid = Number.parseInt(pidField, 10);
  if (!Number.isSafeInteger(panePid) || panePid <= 0) return "unknown";

  const currentCommand = await displayField(runner, session, "#{pane_current_command}");
  if (!currentCommand) return "unknown";

  const shellName = await commandName(panePid, runner);
  // Without a usable shell name we cannot compare, so stay "unknown" — callers
  // fall back to the pre-existing pane-quiescence behavior rather than blocking.
  if (!shellName) return "unknown";

  return currentCommand === shellName ? "idle" : "foreground-busy";
}

export function attachArgs(session: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.TMUX) return ["tmux", "switch-client", "-t", exactTarget(session)];
  return ["tmux", "attach-session", "-t", exactTarget(session)];
}

export async function attachSession(options: {
  session: string;
  env?: NodeJS.ProcessEnv;
  runner?: TmuxRunner;
}): Promise<void> {
  const args = attachArgs(options.session, options.env);
  const result = await (options.runner ?? runInteractiveProcess)(args);
  if (result.code !== 0) {
    throw new WuxError(`failed to attach to ${options.session}: ${result.stderr || result.stdout || `tmux exited ${result.code}`}`.trim());
  }
}
