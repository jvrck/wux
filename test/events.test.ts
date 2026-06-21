import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendBackendSignal, appendEvent, readBackendSignalObservation, readLatestBackendSignal, readEvents } from "../src/runtime/events";
import { tempState } from "./helpers";

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("backend signal events", () => {
  test("append and read the backend-signal event shape and state files", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("backend-signal");

    try {
      await appendBackendSignal(name, {
        signal: "turn-complete",
        at: "2026-06-08T00:00:00.000Z",
        turnId: "turn-1",
        lastAssistantMessage: "done",
      });

      expect(await readEvents(name)).toEqual([
        {
          type: "backend-signal",
          run: name,
          signal: "turn-complete",
          at: "2026-06-08T00:00:00.000Z",
          turnId: "turn-1",
          lastAssistantMessage: "done",
        },
      ]);
      expect(await readLatestBackendSignal(name)).toEqual({
        type: "backend-signal",
        run: name,
        signal: "turn-complete",
        at: "2026-06-08T00:00:00.000Z",
        turnId: "turn-1",
        lastAssistantMessage: "done",
      });

      const dir = join(temp.stateHome, "wux", "runs", name);
      expect(await readFile(join(dir, "turn-complete"), "utf8")).toContain("2026-06-08T00:00:00.000Z");
      expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8"))).toEqual({
        lastSignal: "turn-complete",
        at: "2026-06-08T00:00:00.000Z",
        turnId: "turn-1",
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("reads latest backend signal from state.json when events are absent", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("backend-state");
    const dir = join(temp.stateHome, "wux", "runs", name);

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "state.json"),
        `${JSON.stringify({ lastSignal: "awaiting-approval", at: "2026-06-08T00:00:00.000Z", turnId: "turn-2" })}
`,
        "utf8",
      );

      expect(await readLatestBackendSignal(name)).toEqual({
        type: "backend-signal",
        run: name,
        signal: "awaiting-approval",
        at: "2026-06-08T00:00:00.000Z",
        turnId: "turn-2",
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });

  test("observes only backend signals after the latest turn input", async () => {
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("backend-observe");

    try {
      await appendBackendSignal(name, { signal: "turn-complete", at: "2026-06-08T00:00:00.000Z" });
      await appendEvent(name, { type: "send", at: "2026-06-08T00:00:01.000Z", bytes: 3 });

      expect(await readLatestBackendSignal(name)).toMatchObject({ signal: "turn-complete" });
      expect(await readBackendSignalObservation(name)).toEqual({
        lastTurnInputAt: "2026-06-08T00:00:01.000Z",
      });

      await appendBackendSignal(name, { signal: "awaiting-approval", at: "2026-06-08T00:00:02.000Z" });
      expect(await readBackendSignalObservation(name)).toEqual({
        lastTurnInputAt: "2026-06-08T00:00:01.000Z",
        signal: {
          type: "backend-signal",
          run: name,
          signal: "awaiting-approval",
          at: "2026-06-08T00:00:02.000Z",
        },
      });
    } finally {
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});
