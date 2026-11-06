import "server-only";
import { after } from "next/server";

const pending = new Set<Promise<unknown>>();

/**
 * Run work after the response is sent but guarantee it completes (Next `after`, i.e. waitUntil on Vercel).
 * Outside a request scope (unit tests, scripts) it runs detached but tracked, see flushBackground.
 */
export function runInBackground(fn: () => Promise<unknown>): void {
  const task = async () => {
    try {
      await fn();
    } catch {
      console.error("background task failed"); // no details: may contain account data
    }
  };
  try {
    after(task);
  } catch {
    const p = task().finally(() => pending.delete(p));
    pending.add(p);
  }
}

/** Test helper: wait for detached background tasks. */
export async function flushBackground(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
