import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn() }));

import { POST as pengajarRoute } from "@/app/api/kep/[id]/subevent/[sid]/pengajar/route";
import { getJadwal } from "@/lib/kep/jadwal";
import { SESSION_COOKIE, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const A = F.akunKep;
const AU = F.auditKep;
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const admB: Session = { accountId: "recADMB000000001", email: "admb@x.id", role: "ADMIN", parokiId: PB };
const KEP = "recKEPA0000000001";
const KEP_B = "recKEPB0000000001";
const KEP_X = "recKEPX0000000001"; // Ditolak
const EV = "recEVA00000000001";
const EV_B = "recEVB00000000001";
const EV_X = "recEVX00000000001";
const S1 = "recSUB1000000001";
const S2 = "recSUB2000000001";
const SB = "recSUBB000000001";
const SX = "recSUBX000000001";
const P1 = "recPENGAJAR000001";
const P2 = "recPENGAJAR000002";
const P3 = "recPENGAJAR000003"; // tidak aktif
let ip = 0;

async function call(body: unknown, o: { as?: Session; params: { id: string; sid: string }; headers?: Record<string, string> }) {
  const req = new Request("https://kep.test/api/kep/x/subevent/y/pengajar", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-real-ip": `10.4.0.${++ip % 250}`,
      ...(o.as ? { cookie: `${SESSION_COOKIE}=${await issueSession(o.as, { amr: ["pwd", "otp"] })}` } : {}),
      ...o.headers,
    },
    body: JSON.stringify(body),
  });
  return (pengajarRoute as unknown as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(o.params) });
}
const set = (ids: unknown, as: Session | undefined = pic, extra: Record<string, unknown> = {}, params = { id: KEP, sid: S1 }) =>
  call({ pengajarIds: ids, opId: "op-pengajar-0001", ...extra }, { as, params });
const linksOf = (sid: string) => store[T.subEvent].find((r) => r.id === sid)?.fields[F.subEvent.pengajar];
const auditOf = (aksi: string) => (store[T.auditKep] ?? []).filter((r) => r.fields[AU.aksi] === aksi);

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  await seedAccount({ id: sep.accountId, email: sep.email, peran: "SEP" });
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: admB.accountId, email: admB.email, peran: "Admin Paroki", fields: { [A.paroki]: [PB] } });
  store[T.penyelenggaraKep] = [
    { id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: "recORGB0000000001", fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  store[T.eventKep] = [
    { id: KEP, fields: { [F.eventKep.events]: [EV], [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.statusPersetujuan]: "Disetujui" } },
    { id: KEP_B, fields: { [F.eventKep.events]: [EV_B], [F.eventKep.penyelenggara]: ["recORGB0000000001"], [F.eventKep.statusPersetujuan]: "Disetujui" } },
    { id: KEP_X, fields: { [F.eventKep.events]: [EV_X], [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.statusPersetujuan]: "Ditolak" } },
  ];
  store[T.subEvent] = [
    { id: S1, fields: { [F.subEvent.acara]: [EV], [F.subEvent.agenda]: "Pertemuan 1", [F.subEvent.urutan]: 1, [F.subEvent.tanggal]: "2026-11-10" } },
    { id: S2, fields: { [F.subEvent.acara]: [EV], [F.subEvent.agenda]: "Pertemuan 2", [F.subEvent.urutan]: 2, [F.subEvent.tanggal]: "2026-11-17", [F.subEvent.pengajar]: [P1] } },
    { id: SB, fields: { [F.subEvent.acara]: [EV_B], [F.subEvent.agenda]: "Paroki B", [F.subEvent.urutan]: 1, [F.subEvent.tanggal]: "2026-11-10", [F.subEvent.pengajar]: [P2] } },
    { id: SX, fields: { [F.subEvent.acara]: [EV_X], [F.subEvent.agenda]: "Ditolak", [F.subEvent.urutan]: 1, [F.subEvent.tanggal]: "2026-11-10" } },
  ];
  store[T.pengajarKep] = [
    { id: P1, fields: { [F.pengajarKep.nama]: "Pewarta Satu", [F.pengajarKep.status]: "Aktif" } },
    { id: P2, fields: { [F.pengajarKep.nama]: "Pewarta Dua", [F.pengajarKep.status]: "Aktif" } },
    { id: P3, fields: { [F.pengajarKep.nama]: "Pewarta Pensiun", [F.pengajarKep.status]: "Tidak Aktif" } },
  ];
  store[T.babKep] = [];
  store[T.auditKep] = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/kep/[id]/subevent/[sid]/pengajar", () => {
  it("PIC sets (replaces) the pengajar of one pertemuan and audits before/after ids", async () => {
    const r = await set([P1, P2]);
    expect(r.status).toBe(200);
    expect((await r.json()).pengajarIds).toEqual([P1, P2]);
    expect(linksOf(S1)).toEqual([P1, P2]);
    const rows = auditOf("pengajar_set");
    expect(rows).toHaveLength(1);
    expect(rows[0].fields[AU.targetId]).toBe(S1);
    expect(rows[0].fields[AU.pelaku]).toBe(pic.email);
    expect(JSON.parse(String(rows[0].fields[AU.sebelum])).ids).toEqual([]);
    expect(JSON.parse(String(rows[0].fields[AU.sesudah])).ids).toEqual([P1, P2]);
    expect(JSON.stringify(rows[0].fields)).not.toMatch(/Pewarta (Satu|Dua)/);
  });
  it("replaces rather than appends, can clear, and dedupes", async () => {
    await set([P1, P2], pic, { opId: "op-pengajar-0001" });
    await set([P2, P2], pic, { opId: "op-pengajar-0002" });
    expect(linksOf(S1)).toEqual([P2]);
    await set([], pic, { opId: "op-pengajar-0003" });
    expect(linksOf(S1)).toEqual([]);
    expect(auditOf("pengajar_set")).toHaveLength(3);
  });
  it("does not touch other pertemuan", async () => {
    await set([P2]);
    expect(linksOf(S2)).toEqual([P1]);
    expect(linksOf(SB)).toEqual([P2]);
  });
  it("422 for inactive, unknown, malformed or too many pengajar; nothing is written", async () => {
    for (const ids of [[P3], ["recNOSUCHPENGAJAR"], ["not-an-id"], "P1", [P1, 5], Array.from({ length: 11 }, (_, i) => `recPENGAJAR0000${String(i).padStart(2, "0")}`)]) {
      expect((await set(ids)).status).toBe(422);
    }
    expect(linksOf(S1)).toBeUndefined();
    expect(auditOf("pengajar_set")).toHaveLength(0);
  });
  it("422 for a bad opId, missing fields and unknown keys", async () => {
    expect((await set([P1], pic, { opId: "x" })).status).toBe(422);
    expect((await call({ pengajarIds: [P1] }, { as: pic, params: { id: KEP, sid: S1 } })).status).toBe(422);
    expect((await set([P1], pic, { status: "Disetujui" })).status).toBe(422);
    expect(linksOf(S1)).toBeUndefined();
  });
  it("401 anonymous, 403 SEP, 403 cross-site", async () => {
    expect((await set([P1], undefined)).status).toBe(401);
    expect((await set([P1], sep)).status).toBe(403);
    expect((await call({ pengajarIds: [P1], opId: "op-pengajar-0001" }, { as: pic, params: { id: KEP, sid: S1 }, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(linksOf(S1)).toBeUndefined();
  });
  it("IDOR: other parish 404; pertemuan of another KEP under an own KEP id 404; foreign KEP id 404", async () => {
    expect((await set([P1], admB)).status).toBe(404); // parish B on KEP A
    expect((await set([P1], pic, {}, { id: KEP, sid: SB })).status).toBe(404); // own KEP, foreign pertemuan
    expect((await set([P1], pic, {}, { id: KEP_B, sid: SB })).status).toBe(404); // foreign KEP
    expect((await set([P1], pic, {}, { id: KEP, sid: "recNOSUCHSUB00001" })).status).toBe(404);
    expect((await set([P1], pic, {}, { id: KEP, sid: "bad id" })).status).toBe(404);
    expect(linksOf(SB)).toEqual([P2]);
    expect(linksOf(S1)).toBeUndefined();
    expect(auditOf("pengajar_set")).toHaveLength(0);
  });
  it("409 for a rejected KEP", async () => {
    expect((await set([P1], pic, {}, { id: KEP_X, sid: SX })).status).toBe(409);
    expect(linksOf(SX)).toBeUndefined();
  });
  it("is idempotent per opId: replay does not add audit rows; a different body with the same opId is 409", async () => {
    expect((await set([P1, P2])).status).toBe(200);
    expect((await set([P1, P2])).status).toBe(200);
    expect(auditOf("pengajar_set")).toHaveLength(1);
    expect((await set([P1])).status).toBe(409);
    expect(linksOf(S1)).toEqual([P1, P2]);
  });
  it("a replay re-applies a write that was lost after the audit row, unless a newer opId superseded it", async () => {
    await set([P1, P2]);
    delete store[T.subEvent].find((r) => r.id === S1)!.fields[F.subEvent.pengajar]; // write lost
    expect((await set([P1, P2])).status).toBe(200);
    expect(linksOf(S1)).toEqual([P1, P2]);
    await set([P2], pic, { opId: "op-pengajar-0002" });
    expect((await set([P1, P2])).status).toBe(200); // old op replayed late
    expect(linksOf(S1)).toEqual([P2]);
  });
});

describe("getJadwal", () => {
  it("lists the pertemuan of the KEP in order with assigned pengajar names, and the active pewarta options", async () => {
    const j = await getJadwal(pic, KEP);
    expect(j.pertemuan.map((p) => p.id)).toEqual([S1, S2]);
    expect(j.pertemuan[1].pengajarIds).toEqual([P1]);
    expect(j.opsi.map((o) => o.id).sort()).toEqual([P1, P2]);
    expect(j.opsi.every((o) => Object.keys(o).sort().join() === "id,nama")).toBe(true);
    expect(JSON.stringify(j)).not.toMatch(/hp|phone|wa/i);
  });
  it("404 for another parish, 403 for SEP", async () => {
    await expect(getJadwal(admB, KEP)).rejects.toMatchObject({ status: 404 });
    await expect(getJadwal(sep, KEP)).rejects.toMatchObject({ status: 403 });
  });
});
