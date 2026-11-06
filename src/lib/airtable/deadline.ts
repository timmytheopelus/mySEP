import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Route-level time budget for Airtable waits. Inside withAirtableDeadline() no Airtable request waits (queue, 429
 * pause, retries) beyond the absolute deadline: it fails fast with the transient 503 instead of running into the
 * platform's maxDuration kill (which would turn into an unhelpful 504).
 */
const als = new AsyncLocalStorage<{ deadline: number }>();

export const airtableMaxWaitMs = () => {
  const n = Number(process.env.AIRTABLE_MAX_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
};
export function withAirtableDeadline<R>(deadlineAt: number, fn: () => Promise<R>): Promise<R> {
  const outer = als.getStore()?.deadline ?? Infinity;
  return als.run({ deadline: Math.min(deadlineAt, outer) }, fn);
}
/** Absolute deadline of the surrounding route budget, or Infinity. */
export const routeDeadline = () => als.getStore()?.deadline ?? Infinity;
