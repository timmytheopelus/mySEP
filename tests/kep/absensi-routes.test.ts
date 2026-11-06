import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn() }));

import { GET as sheetRoute } from "@/app/api/kep/[id]/absen/[subEventId]/route";
import { POST as setRoute } from "@/app/api/kep/[id]/absen/[subEventId]/set/route";
import { POST as semuaRoute } from "@/app/api/kep/[id]/absen/[subEventId]/semua/route";
import { POST as mundurRoute } from "@/app/api/kep/[id]/peserta/[pid]/mundur/route";
import { POST as hasilRoute } from "@/app/api/kep/[id]/peserta/[pid]/penetapan/route";
import { SESSION_COOKIE, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { resetRateLimitMemory } from "@/lib/ratelimit";
import * as client from "@/lib/airtable/client";
import { AirtableError } from "@/lib/airtable/errors";

const A = F.akunKep;
const P = F.pendaftaranEvents;
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const admB: Session = { accountId: "recADMB000000001", email: "admb@x.id", role: "ADMIN", parokiId: PB };
const KEP = "recKEPA0000000001";
const EV = "recEVA00000000001";
const S1 = "recSUB1000000001";
const PID = "recPEND0000000001";
let ip = 0;

async function call(handler: unknown, body: unknown, o: { as?: Session; method?: string; params: object; headers?: Record<string, string> }) {
  const req = new Request("https://kep.test/api/kep/x", {
    method: o.method ?? "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-real-ip": `10.2.0.${++ip % 250}`,
      ...(o.as ? { cookie: `${SESSION_COOKIE}=${await issueSession(o.as, { amr: ["pwd", "otp"] })}` } : {}),
      ...o.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (handler as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(o.params) });
}

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  await seedAccount({ id: sep.accountId, email: sep.email, peran: "SEP" });
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: admB.accountId, email: admB.email, peran: "Admin Paroki", fields: { [A.paroki]: [PB] } });
  store[T.penyelenggaraKep] = [{ id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } }];
  store[T.eventKep] = [{ id: KEP, fields: { [F.eventKep.events]: [EV], [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.statusPersetujuan]: "Disetujui" } }];
  store[T.subEvent] = [{ id: S1, fields: { [F.subEvent.acara]: [EV], [F.subEvent.agenda]: "Bab 1", [F.subEvent.urutan]: 1, [F.subEvent.tanggal]: "2020-01-01" } }];
  store[T.teamUmat] = [{ id: "recTEAM0000000001", fields: { [F.teamUmat.namaLengkap]: "Agnes" } }];
  store[T.pendaftaranEvents] = [{ id: PID, fields: { [P.event]: [EV], [P.teamUmat]: ["recTEAM0000000001"], [P.statusPendaftaran]: "Confirmed", [P.kategoriKepesertaan]: "Peserta" } }];
  store[T.auditKep] = [];
});
afterEach(() => vi.unstubAllEnvs());

const sp = { id: KEP, subEventId: S1 };
const pp = { id: KEP, pid: PID };

describe("I1: transient Airtable errors are 503 + Retry-After, never 404", () => {
  const transient = (status: number) => new AirtableError(`Airtable request failed: HTTP ${status}`, status, true, 30);
  it.each([429, 500, 502, 503])("set: a transient %i on the row read answers 503 with Retry-After (the queue retries it)", async (st) => {
    const orig = vi.mocked(client.getRecord).getMockImplementation()!;
    vi.mocked(client.getRecord).mockImplementationOnce(async () => {
      throw transient(st);
    });
    const r = await call(setRoute, { pendaftaranId: PID, hadir: true, opId: "op-route-0901" }, { params: sp, as: pic });
    expect(r.status).toBe(503);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    vi.mocked(client.getRecord).mockImplementation(orig);
    // the retry of the same op then succeeds
    expect((await call(setRoute, { pendaftaranId: PID, hadir: true, opId: "op-route-0901" }, { params: sp, as: pic })).status).toBe(200);
  });
  it("network failure / local queue full while listing: 503 (not 500, not 404)", async () => {
    const orig = vi.mocked(client.listRecords).getMockImplementation()!;
    vi.mocked(client.listRecords).mockImplementation(async (t, o) => {
      if (t === T.eventKep) throw new AirtableError("Airtable request failed: busy", 503, true, 2);
      return orig(t, o);
    });
    try {
      const r = await call(sheetRoute, undefined, { method: "GET", params: sp, as: pic });
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("2");
    } finally {
      vi.mocked(client.listRecords).mockImplementation(orig);
    }
  });
  it("a genuine 404 of the row stays 404", async () => {
    const r = await call(setRoute, { pendaftaranId: "recPENDMISSING0001", hadir: true, opId: "op-route-0902" }, { params: sp, as: pic });
    expect(r.status).toBe(404);
  });
});

describe("attendance routes", () => {
  it("GET sheet: 401 anonymous, 403 SEP, 404 other parish, 200 PIC", async () => {
    expect((await call(sheetRoute, undefined, { method: "GET", params: sp })).status).toBe(401);
    expect((await call(sheetRoute, undefined, { method: "GET", params: sp, as: sep })).status).toBe(403);
    expect((await call(sheetRoute, undefined, { method: "GET", params: sp, as: admB })).status).toBe(404);
    const ok = await call(sheetRoute, undefined, { method: "GET", params: sp, as: pic });
    expect(ok.status).toBe(200);
    expect((await ok.json()).peserta).toEqual([{ id: PID, nama: "Agnes", hadir: false, mundur: false }]);
  });
  it("set: PIC marks hadir, replay is stable; SEP 403; cross-parish 404", async () => {
    const body = { pendaftaranId: PID, hadir: true, opId: "op-route-0001" };
    expect((await call(setRoute, body, { params: sp, as: sep })).status).toBe(403);
    expect((await call(setRoute, body, { params: sp, as: admB })).status).toBe(404);
    const a = await call(setRoute, body, { params: sp, as: pic });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ hadir: true });
    expect((await call(setRoute, body, { params: sp, as: pic })).status).toBe(200);
    expect(store[T.pendaftaranEvents][0].fields[P.pertemuanHadir]).toEqual([S1]);
    expect(store[T.auditKep]).toHaveLength(1);
  });
  it("set: rejects bad body (422), extra keys, wrong content type (415), cross-site (403)", async () => {
    expect((await call(setRoute, { pendaftaranId: PID, hadir: "yes", opId: "op-route-0001" }, { params: sp, as: pic })).status).toBe(422);
    expect((await call(setRoute, { pendaftaranId: PID, hadir: true, opId: "x" }, { params: sp, as: pic })).status).toBe(422);
    expect((await call(setRoute, { pendaftaranId: PID, hadir: true, opId: "op-route-0001", extra: 1 }, { params: sp, as: pic })).status).toBe(422);
    expect((await call(setRoute, { pendaftaranId: "nope", hadir: true, opId: "op-route-0001" }, { params: sp, as: pic })).status).toBe(422);
    expect((await call(setRoute, {}, { params: sp, as: pic, headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await call(setRoute, {}, { params: sp, as: pic, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });
  it("semua, mundur, penetapan", async () => {
    const s = await call(semuaRoute, { opId: "op-route-0002" }, { params: sp, as: pic });
    expect(await s.json()).toEqual({ updated: 1, remaining: 0 });
    expect((await call(hasilRoute, { hasil: "LULUS", opId: "op-route-0003" }, { params: pp, as: pic })).status).toBe(200);
    expect(store[T.pendaftaranEvents][0].fields[P.keterangan]).toBe("LULUS");
    expect((await call(hasilRoute, { hasil: "NAIK", opId: "op-route-0003" }, { params: pp, as: pic })).status).toBe(422);
    expect((await call(mundurRoute, { opId: "op-route-0004" }, { params: pp, as: sep })).status).toBe(403);
  });
  it("mundur then set hadir => 409", async () => {
    expect((await call(mundurRoute, { opId: "op-route-0005" }, { params: pp, as: pic })).status).toBe(200);
    expect((await call(setRoute, { pendaftaranId: PID, hadir: true, opId: "op-route-0006" }, { params: sp, as: pic })).status).toBe(409);
  });
  it("batal mundur via the mundur route", async () => {
    await call(mundurRoute, { opId: "op-route-0010" }, { params: pp, as: pic });
    expect(store[T.pendaftaranEvents][0].fields[P.keterangan]).toBe("MENGUNDURKAN DIRI");
    expect((await call(mundurRoute, { opId: "op-route-0011", batal: true }, { params: pp, as: sep })).status).toBe(403);
    expect((await call(mundurRoute, { opId: "op-route-0011", batal: false }, { params: pp, as: pic })).status).toBe(422);
    expect((await call(mundurRoute, { opId: "op-route-0011", batal: true }, { params: pp, as: pic })).status).toBe(200);
    expect(store[T.pendaftaranEvents][0].fields[P.keterangan]).toBeUndefined();
  });
  it("rate limits per actor: 429 with Retry-After", async () => {
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await call(semuaRoute, { opId: `op-route-${String(i).padStart(4, "0")}` }, { params: sp, as: pic })).status;
    expect(last).toBe(429);
  });
});
