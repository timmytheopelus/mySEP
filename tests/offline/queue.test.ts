import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for IndexedDB (node has none). Same async contract as idb-keyval.
const mem = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: async (k: string) => mem.get(k),
  set: async (k: string, v: unknown) => void mem.set(k, v),
  del: async (k: string) => void mem.delete(k),
  update: async (k: string, fn: (v: unknown) => unknown) => void mem.set(k, fn(mem.get(k))),
}));

import { clearDead, clearOfflineQueue, deadLetters, enqueue, flush, pendingOps, type QueuedOp } from "@/lib/offline/queue";

const op = (n: number): QueuedOp => ({ opId: `op-${String(n).padStart(8, "0")}`, url: `/api/x/${n}`, body: { n } });

beforeEach(() => mem.clear());

describe("offline queue", () => {
  it("enqueue keeps order and persists", async () => {
    await enqueue(op(1));
    await enqueue(op(2));
    expect((await pendingOps()).map((o) => o.opId)).toEqual([op(1).opId, op(2).opId]);
  });

  it("flush sends in order and empties the queue", async () => {
    for (const n of [1, 2, 3]) await enqueue(op(n));
    const seen: string[] = [];
    const r = await flush(async (o) => (seen.push(o.opId), true));
    expect(seen).toEqual([op(1).opId, op(2).opId, op(3).opId]);
    expect(r).toMatchObject({ sent: 3, pending: 0, dead: [] });
    expect(await pendingOps()).toEqual([]);
  });

  it("stops at the first network failure and keeps the rest (including the failed op)", async () => {
    for (const n of [1, 2, 3]) await enqueue(op(n));
    const seen: string[] = [];
    const r = await flush(async (o) => (seen.push(o.opId), o.opId !== op(2).opId));
    expect(seen).toEqual([op(1).opId, op(2).opId]);
    expect(r).toMatchObject({ sent: 1, pending: 2 });
    expect((await pendingOps()).map((o) => o.opId)).toEqual([op(2).opId, op(3).opId]);
  });

  it("a thrown send counts as a network failure", async () => {
    await enqueue(op(1));
    const r = await flush(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(r).toMatchObject({ sent: 0, pending: 1 });
  });

  it("retry reuses the stored opId", async () => {
    await enqueue(op(1));
    await flush(async () => false);
    const seen: string[] = [];
    await flush(async (o) => (seen.push(o.opId), true));
    expect(seen).toEqual([op(1).opId]);
  });

  it.each([400, 403, 404, 409, 422])("permanent %i moves the op to dead-letter and the queue continues", async (status) => {
    for (const n of [1, 2, 3]) await enqueue(op(n));
    const r = await flush(async (o) => (o.opId === op(2).opId ? status : true));
    expect(r).toMatchObject({ sent: 2, pending: 0 });
    expect(r.dead.map((d) => [d.opId, d.status])).toEqual([[op(2).opId, status]]);
    expect((await deadLetters()).map((d) => d.opId)).toEqual([op(2).opId]);
    expect(await pendingOps()).toEqual([]);
  });

  it.each([401, 429, 500, 503])("transient %i stops the flush and keeps the op queued", async (status) => {
    for (const n of [1, 2]) await enqueue(op(n));
    const r = await flush(async () => status);
    expect(r).toMatchObject({ sent: 0, pending: 2, dead: [] });
    expect(await deadLetters()).toEqual([]);
  });

  it("clearDead empties the dead-letter list", async () => {
    await enqueue(op(1));
    await flush(async () => 409);
    expect(await deadLetters()).toHaveLength(1);
    await clearDead();
    expect(await deadLetters()).toEqual([]);
  });

  it("concurrent flushes never send an op twice", async () => {
    for (const n of [1, 2]) await enqueue(op(n));
    const seen: string[] = [];
    const send = async (o: QueuedOp) => (await Promise.resolve(), seen.push(o.opId), true);
    await Promise.all([flush(send), flush(send)]);
    expect(seen).toEqual([op(1).opId, op(2).opId]);
  });

  it("ops enqueued while a flush runs are not lost", async () => {
    await enqueue(op(1));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const p = flush(async (o) => (await gate, seen.push(o.opId), true));
    await enqueue(op(2));
    release();
    await p;
    expect(seen).toEqual([op(1).opId, op(2).opId]);
    expect(await pendingOps()).toEqual([]);
  });

  describe("owner scoping", () => {
    const own = (n: number, owner: string, kepId = "K1"): QueuedOp => ({ ...op(n), owner, kepId });

    it("never sends ops of another owner; they stay parked and are not counted", async () => {
      await enqueue(own(1, "A"));
      await enqueue(own(2, "B"));
      await enqueue(own(3, "A"));
      const seen: string[] = [];
      const r = await flush(async (o) => (seen.push(o.opId), true), { owner: "B" });
      expect(seen).toEqual([op(2).opId]);
      expect(r).toMatchObject({ sent: 1, pending: 0 });
      expect((await pendingOps()).map((o) => o.opId)).toEqual([op(1).opId, op(3).opId]);
      expect(await pendingOps("A")).toHaveLength(2);
      expect(await pendingOps("B")).toHaveLength(0);
    });

    it("a network failure for one owner keeps parked ops of the other untouched", async () => {
      await enqueue(own(1, "A"));
      await enqueue(own(2, "B"));
      await flush(async () => false, { owner: "B" });
      expect((await pendingOps()).map((o) => o.opId)).toEqual([op(1).opId, op(2).opId]);
    });

    it("dead letters are per owner and clearDead only clears owner+kep", async () => {
      await enqueue(own(1, "A", "K1"));
      await enqueue(own(2, "A", "K2"));
      await flush(async () => 409, { owner: "A" });
      expect(await deadLetters("B")).toEqual([]);
      expect(await deadLetters("A")).toHaveLength(2);
      await clearDead({ owner: "A", kepId: "K1" });
      expect((await deadLetters("A")).map((d) => d.opId)).toEqual([op(2).opId]);
    });

    it("clearOfflineQueue wipes queue and dead letters", async () => {
      await enqueue(own(1, "A"));
      await enqueue(own(2, "A"));
      await flush(async (o) => (o.opId === op(1).opId ? 409 : false), { owner: "A" });
      await clearOfflineQueue();
      expect(await pendingOps()).toEqual([]);
      expect(await deadLetters()).toEqual([]);
    });
  });
});
