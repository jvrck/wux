import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { WuxError } from "./errors";

// Cross-process advisory lock built on the one filesystem primitive that is
// atomic across processes on every platform: directory creation. `mkdir` either
// creates the dir (we hold the lock) or fails with EEXIST (someone else holds
// it) — there is no read-then-write window to race. No daemon, no flock, no new
// dependency; just a marker dir under the state root. Used to serialize the brief
// window where createSession mutates the SHARED global tmux history-limit, so
// concurrent `wux run`s cannot interleave their read→elevate→restore and leave
// the operator's global wrong (or silently create a pane at the un-elevated
// limit). See createSession for why that window must be atomic.

// How long to keep trying to acquire before giving up. The held window is a
// couple of fast tmux calls, so contention clears quickly; this only bounds a
// pathological pile-up rather than waiting forever.
const ACQUIRE_TIMEOUT_MS = 10_000;
// Backoff between attempts while the lock is held by another process. Short so
// the next waiter grabs the lock promptly once it frees.
const RETRY_INTERVAL_MS = 25;
// A lock dir older than this is presumed abandoned by a crashed run and stolen,
// so a dead process can never deadlock the fleet. Comfortably larger than the
// real held window (a few tmux calls).
const STALE_LOCK_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Best-effort age of the lock dir in ms, or undefined if it is gone / unreadable
// (treated as "not stale" so we never steal a lock we cannot reason about).
async function lockAgeMs(lockPath: string): Promise<number | undefined> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs;
  } catch {
    return undefined;
  }
}

// Acquire `lockPath` and run `fn` while holding it, releasing in a `finally` so
// the lock is freed on every path (success, throw, or rejection). The marker dir
// is created atomically; on contention we back off and retry, stealing the lock
// only if it is older than STALE_LOCK_MS (a crashed holder). Throws WuxError if
// the lock cannot be taken within ACQUIRE_TIMEOUT_MS.
export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  for (;;) {
    try {
      await mkdir(lockPath); // atomic: succeeds only if we created it.
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Held by someone else: steal it if it is stale (crashed holder), else wait.
      const age = await lockAgeMs(lockPath);
      if (age !== undefined && age > STALE_LOCK_MS) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue; // retry immediately after breaking the stale lock
      }
      if (Date.now() >= deadline) {
        throw new WuxError(`timed out acquiring lock ${lockPath} after ${ACQUIRE_TIMEOUT_MS}ms`);
      }
      await delay(RETRY_INTERVAL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}
