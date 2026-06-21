import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { runCommand } from "../src/commands/run";
import { sendCommand } from "../src/commands/send";
import type { ProcessResult } from "../src/runtime/process";
import { loadRun, saveRun } from "../src/runtime/runs";
import { classifyComposerReady, classifySubmission, sendLiteral } from "../src/runtime/tmux";
import { hasTmux, killTmux, tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function memoryIO() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    output: () => ({ stdout, stderr }),
  };
}

describe("send", () => {
  test("sends literal punctuation, submits Enter, and appends byte-count event", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("send-life");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const text = "printf 'wux-send, punctuation ok!\n'";
      await sendCommand({ name, text, forceOwner: false });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const dir = join(temp.stateHome, "wux", "runs", name);
      expect(await readFile(join(dir, "pane.log"), "utf8")).toContain("wux-send, punctuation ok!");
      const events = await readFile(join(dir, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"send"');
      expect(events).toContain(`"bytes":${Buffer.byteLength(text)}`);
      expect(events).not.toContain(text);
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("rejects missing, stopped, and absent-session runs", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("send-dead");
    let created = false;

    try {
      await expect(sendCommand({ name: "missing-run", text: "echo nope", forceOwner: false })).rejects.toThrow("run not found");
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const meta = await loadRun(name);
      await saveRun({ ...meta, status: "stopped" });
      await expect(sendCommand({ name, text: "echo stopped", forceOwner: false })).rejects.toThrow("run is stopped");
      await saveRun({ ...meta, status: "running" });
      await killTmux(name);
      created = false;
      await expect(sendCommand({ name, text: "echo dead", forceOwner: false })).rejects.toThrow("tmux session is not running");
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("enforces owner unless forced", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("send-owner");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const meta = await loadRun(name);
      await saveRun({ ...meta, owner: "other@owner" });
      await expect(sendCommand({ name, text: "echo owner-nope", forceOwner: false })).rejects.toThrow("--force-owner");
      await sendCommand({ name, text: "echo forced-owner-ok", forceOwner: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await readFile(join(temp.stateHome, "wux", "runs", name, "pane.log"), "utf8")).toContain("forced-owner-ok");
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("shell backend send returns a submitted verdict and records it on the event", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("send-verdict");
    let created = false;

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const text = "echo verdict-ok";
      const result = await sendCommand({ name, text, forceOwner: false });
      expect(result).toMatchObject({ name, submission: "submitted", retried: false });
      expect(result.bytes).toBe(Buffer.byteLength(text));
      const events = await readFile(join(temp.stateHome, "wux", "runs", name, "events.jsonl"), "utf8");
      expect(events).toContain('"submission":"submitted"');
      expect(events).toContain('"retried":false');
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("send --json emits the submission envelope via the CLI", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("send-json");
    let created = false;
    const memory = memoryIO();

    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;
      const text = "echo json-ok";
      const code = await runCli(["--local", "send", name, "--json", text], memory.io);
      expect(code).toBe(0);
      const out = JSON.parse(memory.output().stdout.trim());
      expect(out).toEqual({ name, submission: "submitted", retried: false, bytes: Buffer.byteLength(text) });
      expect(memory.output().stderr).toBe("");
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});

describe("classifySubmission", () => {
  test("shell always classifies as submitted", () => {
    expect(classifySubmission("", "", "echo hi", "shell")).toBe("submitted");
  });

  test("text still visible on the composer line is not-submitted", () => {
    const after = "earlier transcript line\n> printf 'hi'";
    expect(classifySubmission("> ", after, "printf 'hi'", "claude")).toBe("not-submitted");
  });

  test("a cleared composer with the text gone is submitted", () => {
    expect(classifySubmission("> printf 'hi'", "working…\n> ", "printf 'hi'", "claude")).toBe("submitted");
  });

  test("an unchanged frame with the text off the composer is uncertain", () => {
    const frame = "printf 'hi' echoed somewhere in the body";
    expect(classifySubmission(frame, frame, "printf 'hi'", "claude")).toBe("uncertain");
  });

  test("empty/whitespace text is uncertain", () => {
    expect(classifySubmission("", "", "   ", "claude")).toBe("uncertain");
  });

  test("strips ANSI and still detects a styled composer prompt as not-submitted", () => {
    const after = "\x1b[2m> \x1b[0mprintf 'hi'";
    expect(classifySubmission("> ", after, "printf 'hi'", "claude")).toBe("not-submitted");
  });

  test("detects width-truncated/wrapped composer text as not-submitted", () => {
    const after = "> this is a very long prompt that the composer wr";
    const text = "this is a very long prompt that the composer wraps across multiple visual lines and is width-truncated";
    expect(classifySubmission("> ", after, text, "claude")).toBe("not-submitted");
  });

  test("detects multi-line input lingering in the composer as not-submitted", () => {
    const text = "first line of the prompt\nsecond line still in composer";
    const after = "> first line of the prompt\nsecond line still in composer";
    expect(classifySubmission("> ", after, text, "claude")).toBe("not-submitted");
  });

  test("detects text on an unprefixed continuation line below the marker as not-submitted", () => {
    // First line is too short to form a signature; the real text sits on the
    // continuation line, which carries no prompt marker of its own.
    const text = "x\nlong continuation line with plenty of lingering content here";
    const after = "> x\n  long continuation line with plenty of lingering content here";
    expect(classifySubmission("> ", after, text, "claude")).toBe("not-submitted");
  });

  test("an empty/unobservable post-submit frame is uncertain, not submitted", () => {
    expect(classifySubmission("had content", "", "do the thing", "claude")).toBe("uncertain");
  });

  test("short text still on the composer prompt line is not-submitted", () => {
    // Too short to form a signature, but exactly occupies the composer head.
    expect(classifySubmission("> ", "> hi", "hi", "claude")).toBe("not-submitted");
  });

  test("a short word matching placeholder chrome but gone from the composer is submitted", () => {
    // Sent "this" submitted; the composer now shows a placeholder example, not our text.
    expect(classifySubmission("> ", "> Explain this codebase", "this", "claude")).toBe("submitted");
  });

  test("multi-line prompt with a blockquote continuation line is not-submitted", () => {
    // The continuation line itself begins with a marker glyph (markdown blockquote);
    // anchoring on the first sent line must still detect the lingering composer text.
    const text = "please review:\n> quoted line still in composer";
    const after = "> please review:\n> quoted line still in composer";
    expect(classifySubmission("> ", after, text, "claude")).toBe("not-submitted");
  });

  test("multi-line prompt with a width-truncated continuation line is not-submitted", () => {
    // First line is short; a later line exceeds the pane width and is truncated.
    const text = "please review:\nthis is a very long continuation line that the composer wraps across multiple visual lines and is width-truncated";
    const after = "> please review:\nthis is a very long continuation line that the composer wr";
    expect(classifySubmission("> ", after, text, "claude")).toBe("not-submitted");
  });

  test("prompt appended after pre-existing composer draft text is not-submitted", () => {
    // Durable session: the composer already held a draft; send appended our prompt
    // at the end, so the sent line is a suffix of the composer head.
    expect(classifySubmission("> draft ", "> draft please review", "please review", "claude")).toBe("not-submitted");
  });

  test("SHORT prompt appended after pre-existing composer draft is not-submitted", () => {
    // Short prompts (hi/go/ok) after a draft must still be caught (word-boundary suffix).
    expect(classifySubmission("> draft ", "> draft hi", "hi", "claude")).toBe("not-submitted");
  });

  test("a short prompt that is only the tail of an unrelated composer word is submitted", () => {
    // "hi" is the tail of "graphi" but not a word-boundary suffix, so it is not lingering.
    expect(classifySubmission("> ", "> graphi", "hi", "claude")).toBe("submitted");
  });

  test("a submitted turn echoed in the transcript above an empty live composer is submitted", () => {
    // Real claude layout (captured live): a submitted user message is re-rendered in
    // the transcript with a "❯ " prefix, ABOVE the (now empty) live composer. The
    // bottom-most composer line is empty, so the text has LEFT the composer — this
    // must read as submitted, NOT a false not-submitted off the transcript echo.
    const before = '❯ Try "write a test for <filepath>"';
    const after = ["❯ respond with exactly: PONG-ALPHA", "", "● PONG-ALPHA", "", "────", "❯ ", "────", "  ⏵⏵ bypass permissions on · ← for agents"].join("\n");
    expect(classifySubmission(before, after, "respond with exactly: PONG-ALPHA", "claude")).toBe("submitted");
  });

  test("a genuine strand on the bottom-most composer line (no composer below) is not-submitted", () => {
    // Counterpart to the echo case: the text is on the LAST composer line with only
    // chrome below, so it really is stranded.
    const after = ["● earlier response", "", "────", "❯ respond with exactly: PONG-ALPHA", "────", "  ⏵⏵ bypass permissions on · esc to interrupt"].join("\n");
    expect(classifySubmission("❯ ", after, "respond with exactly: PONG-ALPHA", "claude")).toBe("not-submitted");
  });

  test("a wrapped single-line strand whose wrap row begins with a marker glyph is not-submitted", () => {
    // The ONE logical sent line wraps; the wrap (continuation) row begins with ">".
    // That row is a contiguous, non-empty visual continuation of the SAME composer —
    // it must NOT be mistaken for a separate live composer below (which would be a
    // dangerous false "submitted" on a real strand).
    const text = "please review this long prompt that wraps and whose wrap row begins with a marker glyph here";
    const after = ["❯ please review this long prompt that wraps and whose wrap", "> row begins with a marker glyph here", "────", "  ⏵⏵ bypass permissions on · esc to interrupt"].join("\n");
    expect(classifySubmission("❯ ", after, text, "claude")).toBe("not-submitted");
  });
});

// Deterministic readiness-gate knobs: no real time, a small fixed sample budget,
// and a base settle of 0. With sleep injected as a no-op the bounded probe runs
// instantly off the supplied frame sequence.
const FAST_GATE = { sleep: async (): Promise<void> => {}, probeIntervalMs: 0, maxProbeSamples: 3, stableSamples: 2, settleMs: 0 } as const;

// A capture stub that yields successive frames and then sticks on the last so a
// slightly-off capture count still reads the final pane state.
function frameCapture(frames: string[]): () => Promise<string> {
  let i = 0;
  return async () => (i < frames.length ? frames[i++] : (frames[frames.length - 1] ?? ""));
}

function recordingRunner(sent: string[][]): (args: string[]) => Promise<ProcessResult> {
  return async (args: string[]): Promise<ProcessResult> => {
    sent.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
}

const enterCount = (sent: string[][]): number => sent.filter((args) => args[args.length - 1] === "Enter").length;

describe("sendLiteral readiness-gated path", () => {
  test("submits once after the typed text renders at-rest (claude)", async () => {
    const sent: string[][] = [];
    // before, 3 ready frames (text rendered, static, not busy) for the gate, then a cleared frame.
    const frames = ["❯ ", "❯ hello there", "❯ hello there", "❯ hello there", "✻ Working…\n❯ "];
    const result = await sendLiteral("wux_x", "hello there", {
      backend: "claude",
      runner: recordingRunner(sent),
      capture: frameCapture(frames),
      ...FAST_GATE,
    });
    expect(result).toEqual({ submission: "submitted", retried: false });
    expect(enterCount(sent)).toBe(1);
    // The literal is typed in one -l (gate only the submit, never the type).
    expect(sent.some((args) => args.includes("-l") && args.includes("hello there"))).toBe(true);
  });

  test("re-confirms readiness then resends once when the first Enter stranded (codex)", async () => {
    const sent: string[][] = [];
    const strand = "› queued instruction";
    const frames = [
      "› ", // before
      strand, strand, strand, // pre-submit gate: ready (text present, idle, static)
      strand, // re-observe after first Enter: text still on composer → not-submitted
      strand, strand, strand, // re-gate before resend: ready again (Enter was dropped, pane idle)
      "• Working (1s • esc to interrupt)\n› ", // re-observe after resend: submitted (text gone)
    ];
    const result = await sendLiteral("wux_x", "queued instruction", {
      backend: "codex",
      runner: recordingRunner(sent),
      capture: frameCapture(frames),
      ...FAST_GATE,
    });
    expect(result).toEqual({ submission: "submitted", retried: true });
    expect(enterCount(sent)).toBe(2); // initial + one resend
  });

  test("withholds Enter entirely into a confirmed-busy pane; reports an honest not-submitted", async () => {
    const sent: string[][] = [];
    // Composer holds the typed text AND the status row shows the busy indicator.
    const busy = "❯ queued instruction\n  ⏵⏵ bypass permissions on · esc to interrupt";
    const frames = ["❯ ", busy, busy, busy, busy, busy, busy, busy, busy];
    const result = await sendLiteral("wux_x", "queued instruction", {
      backend: "claude",
      runner: recordingRunner(sent),
      capture: frameCapture(frames),
      ...FAST_GATE,
    });
    expect(result).toEqual({ submission: "not-submitted", retried: false });
    // No Enter is sent at all — pressing Enter into a pane the gate positively sees
    // as busy is a dropped no-op that just re-strands the (already typed) literal.
    expect(enterCount(sent)).toBe(0);
    // The literal IS still typed (gate only the submit, never the type — no byte loss).
    expect(sent.some((args) => args.includes("-l") && args.includes("queued instruction"))).toBe(true);
  });

  test("busy-then-unknown gate still withholds Enter (busy is sticky across the probe)", async () => {
    const sent: string[][] = [];
    const busy = "❯ queued instruction\n· esc to interrupt";
    const ghost = '❯ Try "something else"'; // a sample where the text anchor is momentarily lost
    const strand = "❯ queued instruction"; // re-observe: text still stranded in the composer
    // before, [gate: busy, busy, ghost], re-observe: strand. The gate sees busy then
    // ends on unknown — it must STILL report busy and withhold the no-op Enter.
    const frames = ["❯ ", busy, busy, ghost, strand];
    const result = await sendLiteral("wux_x", "queued instruction", {
      backend: "claude",
      runner: recordingRunner(sent),
      capture: frameCapture(frames),
      ...FAST_GATE,
    });
    expect(result).toEqual({ submission: "not-submitted", retried: false });
    expect(enterCount(sent)).toBe(0);
  });

  test("multi-line literal is typed in ONE -l and submitted with ONE Enter", async () => {
    const sent: string[][] = [];
    const rendered = "❯ line one\n  line two";
    const frames = ["❯ ", rendered, rendered, rendered, "✻ Working…\n❯ "];
    const result = await sendLiteral("wux_x", "line one\nline two", {
      backend: "claude",
      runner: recordingRunner(sent),
      capture: frameCapture(frames),
      ...FAST_GATE,
    });
    expect(result).toEqual({ submission: "submitted", retried: false });
    const literalSends = sent.filter((args) => args.includes("-l"));
    expect(literalSends.length).toBe(1);
    expect(literalSends[0]).toContain("line one\nline two");
    expect(enterCount(sent)).toBe(1); // one turn, not one Enter per line
  });

  test("scales the settle up for a large paste (bounded)", async () => {
    const sleeps: number[] = [];
    const big = "x".repeat(4096);
    const rendered = `❯ ${big}`;
    const frames = ["❯ ", rendered, rendered, rendered, "✻ Working…\n❯ "];
    await sendLiteral("wux_x", big, {
      backend: "claude",
      runner: recordingRunner([]),
      capture: frameCapture(frames),
      probeIntervalMs: 0,
      maxProbeSamples: 3,
      stableSamples: 2,
      settleMs: 200,
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
    });
    // The submit/re-observe settles are scaled above the 200ms base but stay capped.
    const settleSleeps = sleeps.filter((ms) => ms > 200);
    expect(settleSleeps.length).toBeGreaterThan(0);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(200 + 1500);
  });
});

describe("sendLiteral legacy/degrade paths", () => {
  test("shell backend submits without capturing the pane", async () => {
    let captures = 0;
    const result = await sendLiteral("wux_x", "echo hi", {
      backend: "shell",
      settleMs: 0,
      runner: async (): Promise<ProcessResult> => ({ code: 0, stdout: "", stderr: "" }),
      capture: async () => {
        captures += 1;
        return "";
      },
    });
    expect(result).toEqual({ submission: "submitted", retried: false });
    expect(captures).toBe(0);
  });

  test("kill-switch (readiness:false) reverts to the legacy blind type+Enter+classify", async () => {
    const sent: string[][] = [];
    let captures = 0;
    const frames = ["baseline", "thinking…"]; // before, after (submitted) — no gate captures
    const next = frameCapture(frames);
    const result = await sendLiteral("wux_x", "do the thing", {
      backend: "claude",
      readiness: false,
      settleMs: 0,
      sleep: async (): Promise<void> => {},
      runner: recordingRunner(sent),
      capture: async () => {
        captures += 1;
        return next();
      },
    });
    expect(result).toEqual({ submission: "submitted", retried: false });
    expect(captures).toBe(2); // before + one re-observe only (no readiness probe)
    expect(enterCount(sent)).toBe(1);
  });

  test("legacy path still does the single blind retry on not-submitted", async () => {
    const sent: string[][] = [];
    const frames = ["baseline", "> printf 'hi'", "working…"]; // before, after-1 (strand), after-retry (submitted)
    const result = await sendLiteral("wux_x", "printf 'hi'", {
      backend: "claude",
      readiness: false,
      settleMs: 0,
      sleep: async (): Promise<void> => {},
      runner: recordingRunner(sent),
      capture: frameCapture(frames),
    });
    expect(result).toEqual({ submission: "submitted", retried: true });
    expect(enterCount(sent)).toBe(2);
  });

  test("an unknown backend falls through to the legacy path (never hangs on never-ready)", async () => {
    const sent: string[][] = [];
    const frames = ["baseline", "thinking…"];
    const result = await sendLiteral("wux_x", "do the thing", {
      backend: " collaborator-9000",
      settleMs: 0,
      sleep: async (): Promise<void> => {},
      runner: recordingRunner(sent),
      capture: frameCapture(frames),
    });
    expect(result).toEqual({ submission: "submitted", retried: false });
    expect(enterCount(sent)).toBe(1);
  });

  test("treats an unobservable pane (capture failure) as uncertain, not submitted", async () => {
    const result = await sendLiteral("wux_x", "do the thing", {
      backend: "claude",
      ...FAST_GATE,
      runner: async (): Promise<ProcessResult> => ({ code: 0, stdout: "", stderr: "" }),
      capture: async () => {
        throw new Error("pane gone");
      },
    });
    expect(result).toEqual({ submission: "uncertain", retried: false });
  });
});

describe("classifyComposerReady", () => {
  const composer = (name: string): Promise<string> =>
    readFile(join(import.meta.dir, "fixtures", "composer", `${name}.txt`), "utf8");

  test("fewer than two frames is unknown", () => {
    expect(classifyComposerReady(["❯ hello"], "hello")).toBe("unknown");
  });

  test("empty/whitespace sent text is unknown", () => {
    expect(classifyComposerReady(["❯ ", "❯ "], "   ")).toBe("unknown");
  });

  test("ready: the sent text is rendered on a static, not-busy composer", () => {
    const frame = "earlier output\n❯ summarize the readme";
    expect(classifyComposerReady([frame, frame], "summarize the readme")).toBe("ready");
  });

  test("unknown: at-rest GHOST text is NOT our typed text (no false ready)", () => {
    const ghost = "❯ Try \"how do I log an error?\"";
    expect(classifyComposerReady([ghost, ghost], "summarize the readme")).toBe("unknown");
  });

  test("unknown: the stale pre-render redraw frame (text not yet on composer)", () => {
    const ghost = "❯ Try \"how do I log an error?\"";
    // Two identical stale ghost frames must not pass as ready for the just-typed text.
    expect(classifyComposerReady([ghost, ghost], "do the thing now")).toBe("unknown");
  });

  test("busy: text is on the composer but the status row shows esc to interrupt", () => {
    const frame = "❯ summarize the readme\n  ⏵⏵ bypass permissions on · esc to interrupt";
    expect(classifyComposerReady([frame, frame], "summarize the readme")).toBe("busy");
  });

  test("not false-busy: the sent text ITSELF contains the busy phrase", () => {
    // The phrase is on the composer line (our text), with no real status-row indicator.
    const frame = "❯ document the esc to interrupt hint";
    expect(classifyComposerReady([frame, frame], "document the esc to interrupt hint")).toBe("ready");
  });

  test("busy: frames still changing between samples (streaming/redraw)", () => {
    const a = "❯ summarize the readme\n  thinking 1";
    const b = "❯ summarize the readme\n  thinking 2";
    expect(classifyComposerReady([a, b], "summarize the readme")).toBe("busy");
  });

  test("real fixture: claude at-rest with the pending literal is ready", async () => {
    const frame = await composer("claude-atrest-pending");
    expect(classifyComposerReady([frame, frame], "please summarize the readme")).toBe("ready");
  });

  test("real fixture: claude at-rest EMPTY (ghost) is not ready for a typed literal", async () => {
    const frame = await composer("claude-atrest-empty");
    expect(classifyComposerReady([frame, frame], "please summarize the readme")).toBe("unknown");
  });

  test("real fixture: claude busy pane is not ready", async () => {
    const frame = await composer("claude-busy");
    // The busy fixture's composer is empty; for any typed literal it is not ready.
    expect(classifyComposerReady([frame, frame], "anything at all here")).not.toBe("ready");
  });

  test("real fixture: an idle pane with STRANDED text is ready (strand is classifySubmission's job)", async () => {
    const frame = await composer("claude-strand-idle");
    const stranded = "Run exactly this in bash and wait for it, then reply DONE: sleep 35; echo slept";
    expect(classifyComposerReady([frame, frame], stranded)).toBe("ready");
  });

  test("real fixture: codex at-rest with the pending literal is ready", async () => {
    const frame = await composer("codex-atrest-pending");
    expect(classifyComposerReady([frame, frame], "summarize the readme please")).toBe("ready");
  });

  test("real fixture: codex busy pane is not ready", async () => {
    const frame = await composer("codex-busy");
    expect(classifyComposerReady([frame, frame], "summarize the readme please")).not.toBe("ready");
  });

  test("a submitted-then-echoed turn is NOT ready (prevents a spurious resend/double-submit)", () => {
    // The transcript echo sits above an empty live composer; the text has left the
    // composer, so the resend gate must NOT see it as "ready" (that would press a
    // second Enter into the empty composer — a spurious double-submit).
    const after = ["❯ respond with exactly: PONG-ALPHA", "", "● PONG-ALPHA", "", "────", "❯ ", "────", "  ⏵⏵ bypass permissions on · ← for agents"].join("\n");
    expect(classifyComposerReady([after, after], "respond with exactly: PONG-ALPHA")).toBe("unknown");
  });
});
