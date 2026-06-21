import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProcessResult, processCommandName, runProcess } from "../src/runtime/process";

describe("runProcess", () => {
  test("returns normally when the command finishes before the timeout", async () => {
    const result = await runProcess(["printf", "hello"], { timeoutMs: 5000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
  });

  test("kills a hung command and resolves with a timeout indication", async () => {
    const start = Date.now();
    const result = await runProcess(["sleep", "5"], { timeoutMs: 100 });
    const elapsed = Date.now() - start;

    // The call resolves (never rejects) well before the child would finish.
    expect(elapsed).toBeLessThan(2000);
    expect(result.code).not.toBe(0);
    expect(result.code).toBe(124);
    expect(result.stderr).toContain("timed out");
    expect(result.stderr).toContain("100ms");
  });

  test("the timed-out child is actually killed before it can complete its work", async () => {
    const marker = join(tmpdir(), `wux-kill-${process.pid}-${Date.now()}`);
    rmSync(marker, { force: true });
    try {
      // Would create the marker after 1s; the 100ms timeout must kill it first.
      const result = await runProcess(["sh", "-c", `sleep 1 && : > '${marker}'`], { timeoutMs: 100 });
      expect(result.code).toBe(124);
      // Wait past when the child would have written the marker had it survived.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
    }
  });
});

describe("processCommandName", () => {
  test("returns the executable basename, normalizing a macOS-style full path", async () => {
    const name = await processCommandName(123, async (args): Promise<ProcessResult> => {
      expect(args).toEqual(["ps", "-o", "comm=", "-p", "123"]);
      return { code: 0, stdout: "/bin/zsh\n", stderr: "" };
    });
    expect(name).toBe("zsh");
  });

  test("returns the bare name unchanged when ps already reports a basename", async () => {
    const name = await processCommandName(7, async (): Promise<ProcessResult> => ({ code: 0, stdout: "bash\n", stderr: "" }));
    expect(name).toBe("bash");
  });

  test("returns undefined when ps exits nonzero (pid is gone)", async () => {
    const name = await processCommandName(999999, async (): Promise<ProcessResult> => ({ code: 1, stdout: "", stderr: "no such process" }));
    expect(name).toBeUndefined();
  });

  test("returns undefined for an empty ps result", async () => {
    const name = await processCommandName(8, async (): Promise<ProcessResult> => ({ code: 0, stdout: "\n", stderr: "" }));
    expect(name).toBeUndefined();
  });

  test("returns undefined for a non-positive pid without invoking ps", async () => {
    let called = false;
    const name = await processCommandName(0, async (): Promise<ProcessResult> => {
      called = true;
      return { code: 0, stdout: "zsh\n", stderr: "" };
    });
    expect(name).toBeUndefined();
    expect(called).toBe(false);
  });

  test("resolves this process's own command against a live ps", async () => {
    const name = await processCommandName(process.pid);
    expect(name).toBeDefined();
    // bun runs the test; the executable basename should be bun (or bun-<variant>).
    expect(name).toContain("bun");
  });
});
