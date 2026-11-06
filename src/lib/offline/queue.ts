import { get, del, update } from "idb-keyval";

/** One write waiting for signal. `opId` is generated at tap time and reused by every retry (server dedupes on it). */
export type QueuedOp = { opId: string; url: string; body: object };
export type DeadOp = QueuedOp & { status: number };
/**
 * Outcome of one send: true = delivered; false = no network (retry later); a number = HTTP status of a
 * non-OK response. 400/403/404/409/422 are permanent (dead-letter); any other status is transient.
 */
export type SendResult = boolean | number;

const QUEUE_KEY = "kep:queue";
const DEAD_KEY = "kep:dead";
export const PERMANENT = new Set([400, 403, 404, 409, 422]);

export async function pendingOps(): Promise<QueuedOp[]> {
  return (await get<QueuedOp[]>(QUEUE_KEY)) ?? [];
}

export async function deadLetters(): Promise<DeadOp[]> {
  return (await get<DeadOp[]>(DEAD_KEY)) ?? [];
}

export async function clearDead(): Promise<void> {
  await del(DEAD_KEY);
}

export async function enqueue(op: QueuedOp): Promise<void> {
  await update<QueuedOp[]>(QUEUE_KEY, (q) => [...(q ?? []), op]);
}

const drop = (opId: string) => update<QueuedOp[]>(QUEUE_KEY, (q) => (q ?? []).filter((o) => o.opId !== opId));

let running: Promise<FlushResult> | null = null;
export type FlushResult = { sent: number; pending: number; dead: DeadOp[] };

async function run(send: (op: QueuedOp) => Promise<SendResult>): Promise<FlushResult> {
  let sent = 0;
  const dead: DeadOp[] = [];
  for (;;) {
    const op = (await pendingOps())[0];
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
  return { sent, pending: (await pendingOps()).length, dead };
}

/** Sends queued ops oldest first. Single-flight: concurrent callers share one run (no op is sent twice). */
export function flush(send: (op: QueuedOp) => Promise<SendResult>): Promise<FlushResult> {
  running ??= run(send).finally(() => {
    running = null;
  });
  return running;
}
