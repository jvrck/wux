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

  test("streams raw stdout chunks with backpressure instead of replaying a collected buffer", async () => {
    const source = Buffer.allocUnsafe(256 * 1024 + 19);
    for (let index = 0; index < source.length; index += 1) source[index] = index % 251;
    source[0] = 0x00;
    source[128 * 1024 - 1] = 0xff;
    source[128 * 1024] = 0x00;
    const program = [
      "const first = Buffer.allocUnsafe(128 * 1024);",
      `const second = Buffer.allocUnsafe(${source.length - 128 * 1024});`,
      "for (let index = 0; index < first.length; index += 1) first[index] = index % 251;",
      "for (let index = 0; index < second.length; index += 1) second[index] = (index + first.length) % 251;",
      "first[0] = 0x00; first[first.length - 1] = 0xff; second[0] = 0x00;",
      "process.stdout.write(first);",
      "setTimeout(() => { process.stdout.write(second); process.stderr.write('stream stderr\\n'); process.exit(7); }, 20);",
    ].join("\n");
    const retained: Uint8Array[] = [];
    let writesBeforeDrain = 0;
    let writesBeforeExit = 0;

    const result = await runProcess([process.execPath, "-e", program], {
      stdoutWriter: {
        write: (chunk) => {
          retained.push(chunk);
          writesBeforeExit += 1;
          return retained.length === 1 ? false : true;
        },
        once: (event, listener) => {
          if (event !== "drain") return;
          setTimeout(() => {
            writesBeforeDrain = retained.length;
            listener();
          }, 10);
        },
      },
    });

    expect(result).toMatchObject({ code: 7, stdout: "", stderr: "stream stderr\n" });
    expect(writesBeforeExit).toBeGreaterThan(1);
    expect(writesBeforeDrain).toBe(1);
    expect(Buffer.concat(retained.map((chunk) => Buffer.from(chunk)))).toEqual(source);
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
