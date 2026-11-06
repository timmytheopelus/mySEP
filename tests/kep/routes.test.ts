import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn() }));

import { GET as listQueue, POST as createRoute } from "@/app/api/kep/route";
import { POST as decideRoute } from "@/app/api/kep/[id]/decision/route";
import { setMailer } from "@/lib/email";
import { SESSION_COOKIE, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const A = F.akunKep;
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const adm: Session = { accountId: "recADM0000000001", email: "adm@x.id", role: "ADMIN", parokiId: PA };
let ip = 0;

async function call(handler: unknown, body: unknown, o: { as?: Session; method?: string; params?: object; headers?: Record<string, string> } = {}) {
  const req = new Request("https://kep.test/api/kep", {
    method: o.method ?? "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-real-ip": `10.1.0.${++ip % 250}`,
      ...(o.as ? { cookie: `${SESSION_COOKIE}=${await issueSession(o.as, { amr: ["pwd", "otp"] })}` } : {}),
      ...o.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (handler as (r: Request, c: unknown) => Promise<Response>)(req, o.params ? { params: Promise.resolve(o.params) } : undefined);
}

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("APP_BASE_URL", "https://kep.example.org");
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  setMailer({ send: async () => {} });
  store[T.paroki] = [
    { id: PA, fields: { [F.paroki.nama]: "Pandu" } },
    { id: PB, fields: { [F.paroki.nama]: "Katedral" } },
  ];
  await seedAccount({ id: sep.accountId, email: sep.email, peran: "SEP" });
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: adm.accountId, email: adm.email, peran: "Admin Paroki", fields: { [A.paroki]: [PA] } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  setMailer(null);
});

const future = () => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

describe("POST /api/kep", () => {
  it("401 without session, 403 for ADMIN and SEP", async () => {
    expect((await call(createRoute, { angkatan: 3, tanggalMulai: future() })).status).toBe(401);
    expect((await call(createRoute, { angkatan: 3, tanggalMulai: future() }, { as: adm })).status).toBe(403);
    expect((await call(createRoute, { angkatan: 3, tanggalMulai: future() }, { as: sep })).status).toBe(403);
  });
  it("PIC creates for the own paroki (parokiId optional) -> 201 with ids", async () => {
    const res = await call(createRoute, { angkatan: 3, tanggalMulai: future() }, { as: pic });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.subEventIds).toHaveLength(28);
    expect(store[T.events][0].fields[F.events.namaAcara]).toBe("KEP PAROKI PANDU ANGKATAN 3");
  });
  it("a repeated identical request answers 200 (existing ids) while the first answers 201", async () => {
    const body = { angkatan: 5, tanggalMulai: future() };
    const a = await call(createRoute, body, { as: pic });
    const b = await call(createRoute, body, { as: pic });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect((await b.json()).eventKepId).toBe((await a.json()).eventKepId);
  });
  it("a different parokiId in the body is a 404; unknown keys and bad types are 422", async () => {
    expect((await call(createRoute, { parokiId: PB, angkatan: 3, tanggalMulai: future() }, { as: pic })).status).toBe(404);
    expect((await call(createRoute, { parokiId: PA, angkatan: 3, tanggalMulai: future(), penyelenggara: ["recX00000000001"] }, { as: pic })).status).toBe(422);
    expect((await call(createRoute, { angkatan: "3", tanggalMulai: future() }, { as: pic })).status).toBe(422);
    expect((await call(createRoute, { angkatan: 3, tanggalMulai: "kemarin" }, { as: pic })).status).toBe(422);
    expect(store[T.events] ?? []).toHaveLength(0);
  });
  it("is rate limited per account", async () => {
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await call(createRoute, { angkatan: 100 + i, tanggalMulai: "2020-01-01" }, { as: pic })).status;
    expect(last).toBe(429);
  });
  it("CSRF guard applies", async () => {
    expect((await call(createRoute, { angkatan: 3, tanggalMulai: future() }, { as: pic, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });
  it("a partial failure answers 500 with the created rows and a retry hint", async () => {
    const c = await import("@/lib/airtable/client");
    const real = vi.mocked(c.createRecords).getMockImplementation()!;
    vi.mocked(c.createRecords).mockImplementation(async (t, r, e) => {
      if (t === T.subEvent) throw new Error("Airtable request failed: HTTP 500");
      return real(t, r, e);
    });
    const res = await call(createRoute, { angkatan: 4, tanggalMulai: future() }, { as: pic });
    expect(res.status).toBe(500);
    const b = await res.json();
    expect(b.sudahTerbuat.eventId).toBeTruthy();
    expect(b.error).toMatch(/ulang/i);
    vi.mocked(c.createRecords).mockImplementation(real);
  });
});

describe("decision route and queue", () => {
  const KEP = "recKEPA0000000001";
  beforeEach(() => {
    store[T.penyelenggaraKep] = [{ id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } }];
    store[T.events] = [{ id: "recEVA00000000001", fields: { [F.events.namaAcara]: "KEP PAROKI PANDU ANGKATAN 9" } }];
    store[T.eventKep] = [{ id: KEP, fields: { [F.eventKep.statusPersetujuan]: "Diajukan", [F.eventKep.events]: ["recEVA00000000001"], [F.eventKep.penyelenggara]: ["recORGA0000000001"] } }];
  });
  it("only SEP decides; PIC 403; validation 422; ok 200; second time 409", async () => {
    const p = { params: { id: KEP } };
    expect((await call(decideRoute, { keputusan: "Disetujui" }, { as: pic, ...p })).status).toBe(403);
    expect((await call(decideRoute, { keputusan: "Ditolak", catatan: "" }, { as: sep, ...p })).status).toBe(422);
    expect((await call(decideRoute, { keputusan: "Lain" }, { as: sep, ...p })).status).toBe(422);
    expect((await call(decideRoute, { keputusan: "Disetujui", status: "x" }, { as: sep, ...p })).status).toBe(422);
    const ok = await call(decideRoute, { keputusan: "Disetujui", catatan: "ok" }, { as: sep, ...p });
    expect(ok.status).toBe(200);
    expect((await ok.json()).emailTerkirim).toBe(true);
    expect((await call(decideRoute, { keputusan: "Disetujui" }, { as: sep, ...p })).status).toBe(409);
    expect((await call(decideRoute, { keputusan: "Disetujui" }, { as: sep, params: { id: "recNOPE000000000" } })).status).toBe(404);
  });
  it("GET queue is SEP only", async () => {
    expect((await call(listQueue, undefined, { as: pic, method: "GET" })).status).toBe(403);
    const res = await call(listQueue, undefined, { as: sep, method: "GET" });
    expect(res.status).toBe(200);
    expect((await res.json()).antrean).toHaveLength(1);
  });
});
