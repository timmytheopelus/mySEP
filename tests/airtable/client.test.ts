import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { T, F } from "@/lib/airtable/schema";
import * as client from "@/lib/airtable/client";
import { withAirtableDeadline } from "@/lib/airtable/deadline";

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
  vi.stubEnv("AIRTABLE_429_PAUSE_MS", "1");
  client.resetAirtableThrottle();
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

describe("throttle and transient errors (final fix C1/I1)", () => {
  const ok = () => json({ id: "recX", fields: {} });
  it("never exceeds AIRTABLE_MAX_RPS (default 4, clamped to 5) across concurrent callers", async () => {
    vi.stubEnv("AIRTABLE_MAX_RPS", "50"); // clamped to 5
    expect(client.maxRps()).toBe(5);
    const times: number[] = [];
    fetchMock.mockImplementation(async () => {
      times.push(Date.now());
      return ok();
    });
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 10 }, () => client.getRecord(T.events, "recX")));
    // burst of 5, then 5 more at 5/s: the 10th starts no earlier than ~1 s after the first
    expect(times.at(-1)! - t0).toBeGreaterThanOrEqual(900);
    for (let i = 5; i < times.length; i++) expect(times[i] - times[i - 5]).toBeGreaterThanOrEqual(900);
    vi.unstubAllEnvs();
    expect(client.maxRps()).toBe(4);
  });
  it("a full queue fails fast with a transient 503 (no unbounded pile-up)", async () => {
    vi.stubEnv("AIRTABLE_MAX_RPS", "1");
    vi.stubEnv("AIRTABLE_QUEUE_MAX", "3");
    fetchMock.mockImplementation(async () => ok());
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => client.getRecord(T.events, "recX")));
    const rejected = rs.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) {
      expect(client.isTransientAirtableError(r.reason)).toBe(true);
      expect((r.reason as client.AirtableError).status).toBe(503);
      expect((r.reason as client.AirtableError).retryAfterS).toBeGreaterThanOrEqual(1);
    }
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1 + 3);
  });
  it("M2: inside a route deadline a paused base fails fast (503) instead of waiting the full AIRTABLE_MAX_WAIT_MS", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 429, headers: { "retry-after": "20" } }));
    vi.stubEnv("AIRTABLE_429_PAUSE_MS", "20000");
    const t0 = Date.now();
    await withAirtableDeadline(Date.now() + 500, () => client.getRecord(T.events, "recX")).catch(() => undefined); // 429: pauses the process for 20 s
    const r = await withAirtableDeadline(Date.now() + 500, () => client.getRecord(T.events, "recY")).then(() => null, (e) => e);
    expect(client.isTransientAirtableError(r)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    // past deadline: no request is even attempted
    fetchMock.mockClear();
    const late = await withAirtableDeadline(Date.now() - 1, () => client.getRecord(T.events, "recZ")).then(() => null, (e) => e);
    expect(client.isTransientAirtableError(late)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("honours Retry-After on 429: the whole process pauses, then retries", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => (++n === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : ok()));
    const t0 = Date.now();
    const [a, b] = await Promise.all([client.getRecord(T.events, "recX"), (async () => {
      await new Promise((r) => setTimeout(r, 50));
      return client.getRecord(T.events, "recY");
    })()]);
    expect(a.id).toBe("recX");
    expect(b.id).toBe("recX");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950); // the second caller waited for the pause too
  });
  it("a 429 pause longer than the wait budget fails as transient with Retry-After (no 30 s hang beyond budget)", async () => {
    vi.stubEnv("AIRTABLE_MAX_WAIT_MS", "200");
    fetchMock.mockImplementation(async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    const err = (await client.getRecord(T.events, "recX").catch((e) => e)) as client.AirtableError;
    expect(client.isTransientAirtableError(err)).toBe(true);
    expect(err.retryAfterS).toBeGreaterThanOrEqual(29);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // the pause holds for every later request too, without calling Airtable
    const err2 = (await client.listRecords(T.events, { fields: [] }).catch((e) => e)) as client.AirtableError;
    expect(client.isTransientAirtableError(err2)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("5xx and network errors are transient, never 'not found'; a read is retried once, a write never", async () => {
    fetchMock.mockResolvedValue(json({ error: "x" }, 503));
    const e1 = await client.getRecord(T.events, "recX").catch((e) => e);
    expect(client.isTransientAirtableError(e1)).toBe(true);
    expect(client.isAirtableNotFound(e1)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const e2 = await client.updateRecords(T.events, [{ id: "recX", fields: { [F.events.namaAcara]: "a" } }]).catch((e) => e);
    expect(client.isTransientAirtableError(e2)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ error: "x" }, 502));
    await client.createRecords(T.events, [{ [F.events.namaAcara]: "a" }]).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("a genuine 404 is not transient and is recognised as not-found", async () => {
    fetchMock.mockResolvedValue(json({ error: "NOT_FOUND" }, 404));
    const e = await client.getRecord(T.events, "recX").catch((x) => x);
    expect(client.isTransientAirtableError(e)).toBe(false);
    expect(client.isAirtableNotFound(e)).toBe(true);
  });
});

describe("no delete", () => {
  it("exports no delete/destroy/remove function", async () => {
    const mod = await import("@/lib/airtable/client");
    expect(Object.keys(mod).filter((k) => /delete|destroy|remove/i.test(k))).toEqual([]);
  });
});

describe("hardening (Task 19)", () => {
  it("never issues an HTTP DELETE, whatever exported function is called", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      return json(body ? { records: body.records.map((r: { id?: string }) => ({ id: r.id ?? "recN", fields: {} })) } : { id: "recX", fields: {}, records: [] });
    });
    await client.listRecords(T.events, { fields: [F.events.namaAcara] });
    await client.getRecord(T.events, "recX");
    await client.createRecords(T.events, [{ [F.events.namaAcara]: "a" }]);
    await client.updateRecords(T.events, [{ id: "recX", fields: { [F.events.namaAcara]: "a" } }]);
    const methods = fetchMock.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase());
    expect(methods.length).toBe(4);
    expect(methods).not.toContain("DELETE");
    expect(new Set(methods)).toEqual(new Set(["GET", "POST", "PATCH"]));
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/lib/airtable/client.ts", "utf8")).not.toMatch(/["']DELETE["']/i);
  });

  it("refuses to request a field outside the read allowlist", async () => {
    await expect(client.listRecords(T.events, { fields: ["fldNotInAllowlist000"] })).rejects.toThrow(/allowlist/i);
    await expect(client.listRecords("tblUnknownTable0000", { fields: [] })).rejects.toThrow(/allowlist/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips non-allowlisted fields from list and get responses", async () => {
    fetchMock.mockResolvedValueOnce(json({ records: [{ id: "rec1", fields: { [F.teamUmat.namaLengkap]: "A", fldJabatanBPK00000: "Ketua" } }] }));
    const [r] = await client.listRecords(T.teamUmat, { fields: [F.teamUmat.namaLengkap] });
    expect(r.fields).toEqual({ [F.teamUmat.namaLengkap]: "A" });
    fetchMock.mockResolvedValueOnce(json({ id: "rec1", fields: { [F.teamUmat.namaLengkap]: "A", fldJabatanBPK00000: "Ketua" } }));
    expect((await client.getRecord(T.teamUmat, "rec1")).fields).toEqual({ [F.teamUmat.namaLengkap]: "A" });
  });

  it("surfaces a redacted Airtable error body", async () => {
    fetchMock.mockResolvedValue(json({ error: { type: "INVALID_VALUE_FOR_COLUMN", message: 'Field "x" cannot accept "budi@mail.id 08123456789"' } }, 422));
    const err = await client.getRecord(T.events, "recX").catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 422/);
    expect(String(err)).toContain("INVALID_VALUE_FOR_COLUMN");
    expect(String(err)).not.toContain("budi@mail.id");
    expect(String(err)).not.toContain("08123456789");
  });

  it("ignores AIRTABLE_API_URL in production (token only ever goes to Airtable)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fetchMock.mockResolvedValueOnce(json({ id: "recX", fields: {} }));
    await client.getRecord(T.events, "recX");
    expect(new URL(fetchMock.mock.calls[0][0] as string).origin).toBe("https://api.airtable.com");
  });
});
