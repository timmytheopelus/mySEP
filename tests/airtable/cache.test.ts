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
});
