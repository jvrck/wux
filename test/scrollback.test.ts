import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessResult } from "../src/runtime/process";
import { runProcess } from "../src/runtime/process";
import { capturePane, createSession } from "../src/runtime/tmux";
import { hasTmux, killTmux, tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Record every tmux argv and answer the two reads createSession depends on
// (`tmux -V` and the global history-limit), so the scrollback wiring is testable
// without a live tmux server. Everything else returns success.
function recordingRunner(): { calls: string[][]; runner: (args: string[]) => Promise<ProcessResult> } {
  const calls: string[][] = [];
  const runner = async (args: string[]): Promise<ProcessResult> => {
    calls.push(args);
    if (args[1] === "-V") return { code: 0, stdout: "tmux 3.4\n", stderr: "" };
    if (args[1] === "show-options" && args.includes("-gv")) return { code: 0, stdout: "2000\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

// Poll the full pane history (`capture-pane -S -`) for a needle: the emitter
// loop runs asynchronously inside the new session, so an early line only appears
// once enough of the loop has flushed.
async function paneHistoryHas(session: string, needle: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await runProcess(["tmux", "capture-pane", "-p", "-t", `=${session}:`, "-S", "-"]);
    if (result.code === 0 && result.stdout.includes(needle)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("createSession scrollback wiring (unit, no tmux)", () => {
  test("writes the wux conf, elevates+restores global, pins history-limit at session scope, leaves mouse off", async () => {
    const temp = await tempState();
    const env = { XDG_STATE_HOME: temp.stateHome } as NodeJS.ProcessEnv;
    const { calls, runner } = recordingRunner();
    const session = "wux_unit-scroll";

    try {
      await createSession({
        session,
        cwd: temp.root,
        command: ["sleep", "600"],
        logPath: join(temp.root, "pane.log"),
        env,
        runner,
      });

      // The wux-owned conf lives under the state root and carries the generous limit.
      const confPath = join(temp.stateHome, "wux", "tmux.conf");
      expect(await readFile(confPath, "utf8")).toContain("set-option -g history-limit 50000");

      const find = (predicate: (call: string[]) => boolean): number => calls.findIndex(predicate);
      const elevate = find((c) => c.join(" ") === "tmux set-option -g history-limit 50000");
      const newSession = find((c) => c[1] === "-f" && c[3] === "new-session");
      const restore = find((c) => c.join(" ") === "tmux set-option -g history-limit 2000");
      const pin = find((c) => c.join(" ") === `tmux set-option -t =${session}: history-limit 50000`);

      // The initial pane is created with the limit already elevated, then the
      // operator's global is put back, then the limit is pinned on the session.
      expect(elevate).toBeGreaterThanOrEqual(0);
      expect(newSession).toBeGreaterThan(elevate);
      expect(calls[newSession]).toContain(confPath); // -f <conf> reaches new-session
      expect(restore).toBeGreaterThan(newSession); // global restored after creation
      expect(pin).toBeGreaterThan(newSession);

      // Mouse is never touched without the opt-in.
      expect(calls.some((c) => c.includes("mouse"))).toBe(false);
    } finally {
      await temp.cleanup();
    }
  });

  test("concurrent createSession runs do not leave the operator's global elevated and both panes get the limit", async () => {
    // One shared "tmux server" backing two concurrent runs. A SINGLE mutable cell
    // models the global history-limit that `set-option -g` writes and
    // `show-options -gv` reads, so both runs contend for the same value exactly as
    // they would on the one real tmux server.
    //
    // The fake deterministically forces Race A from #146 by making the SECOND
    // global read PARK until an elevation has landed, then return that elevated
    // value as its "baseline". Without the lock the windows interleave: A reads
    // 2000 → A elevates(50000) → B's read unparks and captures 50000 as its
    // baseline → A restores(2000) → B restores its baseline (50000), leaving the
    // operator's global stuck at 50000. The lock makes A's whole
    // read→elevate→restore atomic, so B cannot read until A has freed the lock at
    // 2000; B's park then drains via the bounded fallback and reads the correct
    // 2000 baseline. Hence this test FAILS without the lock and PASSES with it.
    const baseline = "2000";
    let globalHistoryLimit = baseline;
    const pinnedPerSession = new Map<string, string>();

    let reads = 0;
    let elevated = false;
    let elevateWaiter: (() => void) | undefined;
    const signalElevated = (): void => {
      elevateWaiter?.();
      elevateWaiter = undefined;
    };
    // Park the parked reader until an elevation lands, or a bounded fallback fires
    // (so the lock-serialized case — where no concurrent elevation can arrive while
    // the second reader holds nothing — still drains and reads the real baseline).
    const waitForElevation = (): Promise<void> =>
      new Promise((resolve) => {
        if (elevated) return resolve();
        const timer = setTimeout(resolve, 100);
        elevateWaiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });

    const sharedServerRunner = async (args: string[]): Promise<ProcessResult> => {
      await new Promise((resolve) => setTimeout(resolve, 0)); // yield so runs interleave
      if (args[1] === "-V") return { code: 0, stdout: "tmux 3.4\n", stderr: "" };
      // global reads/writes go through the one shared cell.
      if (args[1] === "show-options" && args.includes("-gv") && args.includes("history-limit")) {
        reads += 1;
        // The second concurrent reader waits to capture whatever the global is once
        // an elevation has happened — the heart of the race.
        if (reads === 2) await waitForElevation();
        return { code: 0, stdout: `${globalHistoryLimit}\n`, stderr: "" };
      }
      if (args[1] === "set-option" && args[2] === "-g" && args[3] === "history-limit") {
        globalHistoryLimit = args[4];
        if (args[4] === "50000") {
          elevated = true;
          signalElevated(); // release a reader parked mid-window
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      // session-scoped pin: `set-option -t =<session>: history-limit <value>`.
      if (args[1] === "set-option" && args[2] === "-t" && args.includes("history-limit")) {
        const target = args[3].replace(/^=/, "").replace(/:$/, "");
        pinnedPerSession.set(target, args[args.length - 1]);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const temp = await tempState();
    const env = { XDG_STATE_HOME: temp.stateHome } as NodeJS.ProcessEnv;
    const run = (session: string): Promise<void> =>
      createSession({
        session,
        cwd: temp.root,
        command: ["sleep", "600"],
        logPath: join(temp.root, `${session}.log`),
        env,
        runner: sharedServerRunner,
      });

    try {
      await Promise.all([run("wux_unit-concA"), run("wux_unit-concB")]);

      // (a) operator's global is back to exactly the original baseline.
      expect(globalHistoryLimit).toBe(baseline);
      // (b) both sessions were pinned at the generous limit.
      expect(pinnedPerSession.get("wux_unit-concA")).toBe("50000");
      expect(pinnedPerSession.get("wux_unit-concB")).toBe("50000");
    } finally {
      await temp.cleanup();
    }
  });

  test("WUX_TMUX_MOUSE=1 adds a single session-scoped `mouse on`", async () => {
    const temp = await tempState();
    const env = { XDG_STATE_HOME: temp.stateHome, WUX_TMUX_MOUSE: "1" } as NodeJS.ProcessEnv;
    const { calls, runner } = recordingRunner();
    const session = "wux_unit-mouse";

    try {
      await createSession({
        session,
        cwd: temp.root,
        command: ["sleep", "600"],
        logPath: join(temp.root, "pane.log"),
        env,
        runner,
      });
      const mouseCalls = calls.filter((c) => c.join(" ") === `tmux set-option -t =${session}: mouse on`);
      expect(mouseCalls).toHaveLength(1);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("createSession scrollback (integration, real tmux)", () => {
  test("history-limit is generous and effective on the initial pane; mouse off by default; read-path intact", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("scroll");
    const session = `wux_${name}`;
    let created = false;

    try {
      const logPath = join(temp.root, "pane.log");
      await writeFile(logPath, "");
      // Emit well past the old 2000-line cap, then stay alive.
      await createSession({
        session,
        cwd: temp.root,
        command: ["bash", "-lc", "for i in $(seq 1 5000); do echo line-$i; done; exec sleep 600"],
        logPath,
      });
      created = true;

      // (a) generous history-limit, readable at session scope.
      const hl = (await runProcess(["tmux", "show-options", "-t", `=${session}:`, "-v", "history-limit"])).stdout.trim();
      expect(Number(hl)).toBeGreaterThanOrEqual(50000);

      // (b) effective on the INITIAL pane: an early line survives past the old cap.
      expect(await paneHistoryHas(session, "line-100")).toBe(true);
      const full = (await runProcess(["tmux", "capture-pane", "-p", "-t", `=${session}:`, "-S", "-"])).stdout;
      expect(full).toContain("line-4999");

      // (c) mouse off by default — the session option is never "on".
      const mouse = (await runProcess(["tmux", "show-options", "-t", `=${session}:`, "-v", "mouse"])).stdout.trim();
      expect(mouse).not.toBe("on");

      // (e) programmatic read-path unaffected.
      const captured = await capturePane(session, 200);
      expect(captured.length).toBeGreaterThan(0);
    } finally {
      if (created) await killTmux(name);
      if (old === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("WUX_TMUX_MOUSE=1 reports `mouse on` on the created session", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const name = uniqueRunName("scroll-mouse");
    const session = `wux_${name}`;
    let created = false;

    try {
      const logPath = join(temp.root, "pane.log");
      await writeFile(logPath, "");
      await createSession({
        session,
        cwd: temp.root,
        command: ["sleep", "600"],
        logPath,
        env: { ...process.env, XDG_STATE_HOME: temp.stateHome, WUX_TMUX_MOUSE: "1" },
      });
      created = true;

      const mouse = (await runProcess(["tmux", "show-options", "-t", `=${session}:`, "-v", "mouse"])).stdout.trim();
      expect(mouse).toBe("on");
    } finally {
      if (created) await killTmux(name);
      await temp.cleanup();
    }
  });
});
