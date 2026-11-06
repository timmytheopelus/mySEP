import { get, del, update } from "idb-keyval";

/** One write waiting for signal. `opId` is generated at tap time and reused by every retry (server dedupes on it). */
export type QueuedOp = { opId: string; url: string; body: object; /** opaque account subject that created the op */ owner?: string; kepId?: string };
export type DeadOp = QueuedOp & { status: number };
/**
 * Outcome of one send: true = delivered; false = no network (retry later); a number = HTTP status of a
 * non-OK response. 400/403/404/409/422 are permanent (dead-letter); any other status is transient.
 */
export type SendResult = boolean | number;

const QUEUE_KEY = "kep:queue";
const DEAD_KEY = "kep:dead";
export const PERMANENT = new Set([400, 403, 404, 409, 422]);

const mine = (owner?: string) => (o: { owner?: string }) => owner === undefined || o.owner === owner;

/** Queued ops; with `owner`, only that account's (others stay parked and invisible). */
export async function pendingOps(owner?: string): Promise<QueuedOp[]> {
  return ((await get<QueuedOp[]>(QUEUE_KEY)) ?? []).filter(mine(owner));
}

export async function deadLetters(owner?: string): Promise<DeadOp[]> {
  return ((await get<DeadOp[]>(DEAD_KEY)) ?? []).filter(mine(owner));
}

/** Clears dead letters, optionally only those of one owner (+ one KEP). */
export async function clearDead(only?: { owner: string; kepId?: string }): Promise<void> {
  if (!only) return del(DEAD_KEY);
  await update<DeadOp[]>(DEAD_KEY, (x) => (x ?? []).filter((d) => !(d.owner === only.owner && (only.kepId === undefined || d.kepId === only.kepId))));
}

/** Logout hook: wipes everything this device holds, BEFORE calling the logout API. */
export async function clearOfflineQueue(): Promise<void> {
  await Promise.all([del(QUEUE_KEY), del(DEAD_KEY)]);
}

export async function enqueue(op: QueuedOp): Promise<void> {
  await update<QueuedOp[]>(QUEUE_KEY, (q) => [...(q ?? []), op]);
}

const drop = (opId: string) => update<QueuedOp[]>(QUEUE_KEY, (q) => (q ?? []).filter((o) => o.opId !== opId));

let running: Promise<FlushResult> | null = null;
export type FlushResult = { sent: number; pending: number; dead: DeadOp[] };

async function run(send: (op: QueuedOp) => Promise<SendResult>, owner?: string): Promise<FlushResult> {
  let sent = 0;
  const dead: DeadOp[] = [];
  for (;;) {
    const op = (await pendingOps(owner))[0];
    if (!op) break;
    let r: SendResult;
    try {
      r = await send(op);
    } catch {
      r = false;
    }
    if (r === true) {
      await drop(op.opId);
      sent++;
    } else if (typeof r === "number" && PERMANENT.has(r)) {
      // One bad op must never block the queue: park it, tell the caller, go on.
      const d: DeadOp = { ...op, status: r };
      await update<DeadOp[]>(DEAD_KEY, (x) => [...(x ?? []), d]);
      await drop(op.opId);
      dead.push(d);
    } else {
      break; // no network, 401/429/5xx: keep this op and everything after it, in order
    }
  }
  return { sent, pending: (await pendingOps(owner)).length, dead };
}

/** Sends queued ops oldest first. Single-flight: concurrent callers share one run (no op is sent twice). */
export function flush(send: (op: QueuedOp) => Promise<SendResult>, opts: { owner?: string } = {}): Promise<FlushResult> {
  running ??= run(send, opts.owner).finally(() => {
    running = null;
  });
  return running;
}
