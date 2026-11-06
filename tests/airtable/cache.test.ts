import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/airtable/client", () => ({ listRecords: vi.fn(async () => [{ id: "recA", fields: {} }]) }));

describe("shared read cache", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is one state per process: a second module copy (route handlers vs pages in the build) sees the same entries and invalidations", async () => {
    const a = await import("@/lib/airtable/cacheStore");
    vi.resetModules();
    const b = await import("@/lib/airtable/cacheStore");
    expect(a).not.toBe(b);
    expect(a.tableCache).toBe(b.tableCache);
    const seen: (string | undefined)[] = [];
    a.onInvalidate((t) => seen.push(t));
    b.invalidateTable("tblX");
    expect(seen).toEqual(["tblX"]);
  });
  it("AIRTABLE_CACHE_TTL_MS=0 disables reuse across calls but keeps single flight", async () => {
    const { cachedList, resetReadCache } = await import("@/lib/airtable/cache");
    const { listRecords } = await import("@/lib/airtable/client");
    resetReadCache();
    vi.stubEnv("AIRTABLE_CACHE_TTL_MS", "0");
    vi.mocked(listRecords).mockClear();
    await Promise.all([cachedList("tblY", ["fldA"]), cachedList("tblY", ["fldA"])]);
    expect(listRecords).toHaveBeenCalledTimes(1);
    await cachedList("tblY", ["fldA"]);
    expect(listRecords).toHaveBeenCalledTimes(2);
    vi.stubEnv("AIRTABLE_CACHE_TTL_MS", "");
    await cachedList("tblY", ["fldA"]);
    await cachedList("tblY", ["fldA"]);
    expect(listRecords).toHaveBeenCalledTimes(2); // default TTL again: the last read is reused
  });
  it("M1: a forced-fresh read (maxAgeMs 0) bypasses the failure backoff and never gets stale rows; ordinary reads still do", async () => {
    const { cachedList, resetReadCache } = await import("@/lib/airtable/cache");
    const { listRecords } = await import("@/lib/airtable/client");
    resetReadCache();
    vi.mocked(listRecords).mockClear();
    const good = await cachedList("tblM1", ["fldA"], undefined, { ttlMs: 0 });
    expect(good).toHaveLength(1);
    vi.mocked(listRecords).mockRejectedValue(new Error("down"));
    expect(await cachedList("tblM1", ["fldA"], undefined, { ttlMs: 0 })).toEqual(good); // ordinary read: stale fallback
    const n = vi.mocked(listRecords).mock.calls.length;
    await expect(cachedList("tblM1", ["fldA"], undefined, { maxAgeMs: 0 })).rejects.toThrow("down"); // fresh: asks again, no stale rows
    expect(vi.mocked(listRecords).mock.calls.length).toBe(n + 1);
    vi.mocked(listRecords).mockImplementation(async () => [{ id: "recA", fields: {} }]);
  });
  it("M1: last-good rows older than 30 minutes are not served during an outage", async () => {
    const { cachedList, resetReadCache } = await import("@/lib/airtable/cache");
    const { listRecords } = await import("@/lib/airtable/client");
    resetReadCache();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await cachedList("tblM1b", ["fldA"], undefined, { ttlMs: 0 });
      vi.mocked(listRecords).mockRejectedValue(new Error("down"));
      vi.setSystemTime(Date.now() + 29 * 60_000);
      expect(await cachedList("tblM1b", ["fldA"], undefined, { ttlMs: 0 })).toHaveLength(1);
      vi.setSystemTime(Date.now() + 2 * 60_000); // 31 min after the good read
      await expect(cachedList("tblM1b", ["fldA"], undefined, { ttlMs: 0 })).rejects.toThrow("down");
    } finally {
      vi.useRealTimers();
      vi.mocked(listRecords).mockImplementation(async () => [{ id: "recA", fields: {} }]);
    }
  });
});
