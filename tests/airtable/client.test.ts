import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { T, F } from "@/lib/airtable/schema";
import * as client from "@/lib/airtable/client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("AIRTABLE_TOKEN", "test-token");
  vi.stubEnv("AIRTABLE_API_URL", "http://mock.local/v0");
  vi.stubEnv("AIRTABLE_BASE_ID", "appTEST");
  vi.stubEnv("AIRTABLE_BACKOFF_MS", "1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("listRecords", () => {
  it("follows offset until exhausted and requests field ids", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ records: [{ id: "rec1", fields: {} }], offset: "o1" }))
      .mockResolvedValueOnce(json({ records: [{ id: "rec2", fields: {} }], offset: "o2" }))
      .mockResolvedValueOnce(json({ records: [{ id: "rec3", fields: {} }] }));
    const recs = await client.listRecords(T.events, {
      fields: [F.events.namaAcara],
      filterByFormula: "1",
      sort: [{ field: F.events.tanggalAcara, direction: "desc" }],
      maxRecords: 50,
    });
    expect(recs.map((r) => r.id)).toEqual(["rec1", "rec2", "rec3"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(`http://mock.local/v0/appTEST/${T.events}`);
    expect(url.searchParams.get("returnFieldsByFieldId")).toBe("true");
    expect(url.searchParams.getAll("fields[]")).toEqual([F.events.namaAcara]);
    expect(url.searchParams.get("filterByFormula")).toBe("1");
    expect(url.searchParams.get("sort[0][field]")).toBe(F.events.tanggalAcara);
    expect(url.searchParams.get("sort[0][direction]")).toBe("desc");
    expect(url.searchParams.get("maxRecords")).toBe("50");
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("offset")).toBe("o1");
    expect(new URL(fetchMock.mock.calls[2][0] as string).searchParams.get("offset")).toBe("o2");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });
});

describe("getRecord", () => {
  it("fetches one record by id", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "recX", fields: {} }));
    const r = await client.getRecord(T.events, "recX");
    expect(r.id).toBe("recX");
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe(`/v0/appTEST/${T.events}/recX`);
    expect(url.searchParams.get("returnFieldsByFieldId")).toBe("true");
  });
});

describe("createRecords", () => {
  it("chunks 25 rows into 10/10/5 and strips non-allowlisted fields", async () => {
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return json({ records: body.records.map((_: unknown, i: number) => ({ id: `rec${i}`, fields: {} })) });
    });
    const rows = Array.from({ length: 25 }, (_, i) => ({
      [F.teamUmat.namaLengkap]: `N${i}`,
      fldNotInAllowlist000: "x",
    }));
    const out = await client.createRecords(T.teamUmat, rows);
    expect(out).toHaveLength(25);
    const sizes = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).records.length);
    expect(sizes).toEqual([10, 10, 5]);
    const first = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(first.returnFieldsByFieldId).toBe(true);
    expect(first.records[0]).toEqual({ fields: { [F.teamUmat.namaLengkap]: "N0" } });
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });
});

describe("updateRecords", () => {
  it("chunks by 10 using PATCH", async () => {
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return json({ records: body.records.map((r: { id: string }) => ({ id: r.id, fields: {} })) });
    });
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `rec${i}`, fields: { [F.teamUmat.namaLengkap]: "A" } }));
    const out = await client.updateRecords(T.teamUmat, rows);
    expect(out).toHaveLength(12);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
  });
});

describe("retry", () => {
  it("retries 429 up to 3 times then throws", async () => {
    fetchMock.mockImplementation(async () => json({ error: "rate" }, 429));
    await expect(client.listRecords(T.events, { fields: [] })).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("recovers when a retry succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({ records: [{ id: "rec1", fields: {} }] }));
    expect(await client.listRecords(T.events, { fields: [] })).toHaveLength(1);
  });

  it("throws on other HTTP errors without retry", async () => {
    fetchMock.mockResolvedValue(json({ error: "bad" }, 422));
    await expect(client.getRecord(T.events, "recX")).rejects.toThrow(/422/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("no delete", () => {
  it("exports no delete/destroy/remove function", async () => {
    const mod = await import("@/lib/airtable/client");
    expect(Object.keys(mod).filter((k) => /delete|destroy|remove/i.test(k))).toEqual([]);
  });
});
