import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import { createRecords } from "@/lib/airtable/client";
import { POST as jadwalRoute } from "@/app/api/kep/[id]/subevent/[sid]/jadwal/route";
import { getJadwal } from "@/lib/kep/jadwal";
import { getAbsenSheet, listPertemuan } from "@/lib/kep/absensi";
import { getKepHub } from "@/lib/kep/hub";
import { SESSION_COOKIE, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const A = F.akunKep;
const AU = F.auditKep;
const SE = F.subEvent;
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const picB: Session = { accountId: "recPICB000000001", email: "picb@x.id", role: "PIC", parokiId: PB };
const admA: Session = { accountId: "recADMA000000001", email: "adma@x.id", role: "ADMIN", parokiId: PA };
const KEP = "recKEPA0000000001"; // Diajukan, mulai 2026-11-10
const KEP_OK = "recKEPL0000000001"; // Disetujui
const KEP_X = "recKEPX0000000001"; // Ditolak
const KEP_B = "recKEPB0000000001";
const EV = "recEVA00000000001";
const EV_OK = "recEVL00000000001";
const EV_X = "recEVX00000000001";
const EV_B = "recEVB00000000001";
const S1 = "recSUB1000000001";
const S2 = "recSUB2000000001";
const SOK = "recSUBL000000001";
const SX = "recSUBX000000001";
const SB = "recSUBB000000001";
let ip = 0;

async function call(body: unknown, as: Session | null, params: { id: string; sid: string }) {
  const req = new Request("https://kep.test/api/kep/x/subevent/y/jadwal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-real-ip": `10.5.0.${++ip % 250}`,
      ...(as ? { cookie: `${SESSION_COOKIE}=${await issueSession(as, { amr: ["pwd", "otp"] })}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return (jadwalRoute as unknown as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(params) });
}
const W = { tanggal: "2026-11-12", jamMulai: "19:00", jamSelesai: "21:00", opId: "op-jadwal-0001" };
const set = (extra: Record<string, unknown> = {}, as: Session | null = pic, params = { id: KEP, sid: S1 }) => call({ ...W, ...extra }, as, params);
const row = (sid: string) => store[T.subEvent].find((r) => r.id === sid)!.fields;
const auditOf = (aksi: string) => (store[T.auditKep] ?? []).filter((r) => r.fields[AU.aksi] === aksi);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T05:00:00Z")); // 2026-11-08 WIB
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  invalidateKepCache();
  await seedAccount({ id: sep.accountId, email: sep.email, peran: "SEP" });
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: picB.accountId, email: picB.email, peran: "PIC Paroki", fields: { [A.paroki]: [PB] } });
  await seedAccount({ id: admA.accountId, email: admA.email, peran: "Admin Paroki", fields: { [A.paroki]: [PA] } });
  store[T.penyelenggaraKep] = [
    { id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: "recORGB0000000001", fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  const k = (events: string[], org: string, status: string) => ({ [F.eventKep.events]: events, [F.eventKep.penyelenggara]: [org], [F.eventKep.statusPersetujuan]: status, [F.eventKep.tanggalMulai]: "2026-11-10" });
  store[T.eventKep] = [
    { id: KEP, fields: k([EV], "recORGA0000000001", "Diajukan") },
    { id: KEP_OK, fields: k([EV_OK], "recORGA0000000001", "Disetujui") },
    { id: KEP_X, fields: k([EV_X], "recORGA0000000001", "Ditolak") },
    { id: KEP_B, fields: k([EV_B], "recORGB0000000001", "Disetujui") },
  ];
  const s = (acara: string, urutan: number, tanggal: string) => ({ [SE.acara]: [acara], [SE.agenda]: `Pertemuan ${urutan}`, [SE.urutan]: urutan, [SE.tanggal]: tanggal });
  store[T.subEvent] = [
    { id: S1, fields: s(EV, 1, "2026-11-10") },
    { id: S2, fields: s(EV, 2, "2026-11-17") },
    { id: SOK, fields: s(EV_OK, 1, "2026-11-10") },
    { id: SX, fields: s(EV_X, 1, "2026-11-10") },
    { id: SB, fields: s(EV_B, 1, "2026-11-10") },
  ];
  store[T.pengajarKep] = [];
  store[T.auditKep] = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/kep/[id]/subevent/[sid]/jadwal (I7)", () => {
  it("PIC edits tanggal, jam mulai and jam selesai of one pertemuan; only that row changes; audit has before/after", async () => {
    const r = await set();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ tanggal: "2026-11-12", jamMulai: "19:00", jamSelesai: "21:00" });
    expect(row(S1)[SE.tanggal]).toBe("2026-11-12");
    expect(row(S1)[SE.jamMulai]).toBe("19:00");
    expect(row(S1)[SE.jamSelesai]).toBe("21:00");
    expect(row(S2)[SE.tanggal]).toBe("2026-11-17");
    expect(row(S1)[SE.agenda]).toBe("Pertemuan 1"); // never reorders / renames
    expect(store[T.subEvent]).toHaveLength(5); // never creates or deletes
    const rows = auditOf("jadwal_set");
    expect(rows).toHaveLength(1);
    expect(rows[0].fields[AU.targetId]).toBe(S1);
    expect(rows[0].fields[AU.pelaku]).toBe(pic.email);
    expect(JSON.parse(String(rows[0].fields[AU.sebelum]))).toMatchObject({ tanggal: "2026-11-10" });
    expect(JSON.parse(String(rows[0].fields[AU.sesudah]))).toMatchObject({ tanggal: "2026-11-12", jamMulai: "19:00", jamSelesai: "21:00", kepId: KEP });
  });
  it("jam may be cleared together, but not just one of them", async () => {
    expect((await set({ jamMulai: "", jamSelesai: "" })).status).toBe(200);
    expect(row(S1)[SE.jamMulai] ?? "").toBe("");
    expect((await set({ jamMulai: "19:00", jamSelesai: "", opId: "op-jadwal-0002" })).status).toBe(422);
  });
  it.each([
    ["not a date", { tanggal: "besok" }],
    ["impossible date", { tanggal: "2026-02-30" }],
    ["datetime", { tanggal: "2026-11-12T00:00:00Z" }],
    ["24:00", { jamMulai: "24:00" }],
    ["no leading zero", { jamMulai: "9:00" }],
    ["end == start", { jamMulai: "19:00", jamSelesai: "19:00" }],
    ["end < start", { jamMulai: "21:00", jamSelesai: "19:00" }],
    ["before KEP start", { tanggal: "2026-11-09" }],
    ["more than 1 year after KEP start", { tanggal: "2027-11-11" }],
    ["bad opId", { opId: "x" }],
    ["unknown key", { agenda: "hack" }],
  ])("validation: %s -> 422 and nothing written", async (_n, extra) => {
    const r = await set(extra as Record<string, unknown>);
    expect(r.status).toBe(422);
    expect(row(S1)[SE.tanggal]).toBe("2026-11-10");
    expect(auditOf("jadwal_set")).toHaveLength(0);
  });
  it("boundaries: KEP start day and start + 1 year are accepted", async () => {
    expect((await set({ tanggal: "2026-11-10" })).status).toBe(200);
    expect((await set({ tanggal: "2027-11-10", opId: "op-jadwal-0002" })).status).toBe(200);
  });
  it("PIC may edit dates while Diajukan AND after Disetujui (pewarta stays locked elsewhere), not when Ditolak", async () => {
    expect((await set({}, pic, { id: KEP_OK, sid: SOK })).status).toBe(200);
    expect(row(SOK)[SE.tanggal]).toBe("2026-11-12");
    expect((await set({}, pic, { id: KEP_X, sid: SX })).status).toBe(409);
    expect(row(SX)[SE.tanggal]).toBe("2026-11-10");
  });
  it("SEP may edit on any non-rejected KEP of any paroki, audited with its role; Ditolak is 409", async () => {
    expect((await set({}, sep, { id: KEP_B, sid: SB })).status).toBe(200);
    expect(JSON.parse(String(auditOf("jadwal_set")[0].fields[AU.sesudah])).role).toBe("SEP");
    expect((await set({ opId: "op-jadwal-0002" }, sep, { id: KEP_X, sid: SX })).status).toBe(409);
  });
  it("ADMIN 403, anonymous 401, other parish 404 (no write)", async () => {
    expect((await set({}, admA)).status).toBe(403);
    expect((await set({}, null)).status).toBe(401);
    expect((await set({}, picB)).status).toBe(404);
    expect(row(S1)[SE.tanggal]).toBe("2026-11-10");
    expect(auditOf("jadwal_set")).toHaveLength(0);
  });
  it("the pertemuan must belong to THIS KEP (id from the URL is not trusted)", async () => {
    expect((await set({}, pic, { id: KEP, sid: SOK })).status).toBe(404); // own parish, another KEP
    expect((await set({}, pic, { id: KEP, sid: SB })).status).toBe(404); // foreign parish
    expect((await set({}, pic, { id: KEP, sid: "recDOESNOTEXIST01" })).status).toBe(404);
    expect(row(SOK)[SE.tanggal]).toBe("2026-11-10");
    expect(row(SB)[SE.tanggal]).toBe("2026-11-10");
  });
  it("opId is idempotent and bound to the payload: a replay is a no-op, a different payload under the same opId is 409", async () => {
    expect((await set()).status).toBe(200);
    expect((await set()).status).toBe(200);
    expect(auditOf("jadwal_set")).toHaveLength(1);
    expect((await set({ tanggal: "2026-11-13" })).status).toBe(409);
    expect(row(S1)[SE.tanggal]).toBe("2026-11-12");
  });
  it("a replay after the write was lost re-applies it (jadwal_set_ulang); a newer save is not resurrected", async () => {
    expect((await set()).status).toBe(200);
    row(S1)[SE.tanggal] = "2026-11-10"; // lost write
    expect((await set()).status).toBe(200);
    expect(row(S1)[SE.tanggal]).toBe("2026-11-12");
    expect(auditOf("jadwal_set_ulang")).toHaveLength(1);
    expect((await set({ tanggal: "2026-11-14", opId: "op-jadwal-0002" })).status).toBe(200);
    expect((await set()).status).toBe(200); // old op again: later save wins
    expect(row(S1)[SE.tanggal]).toBe("2026-11-14");
  });
  it("audit failure aborts the write", async () => {
    vi.mocked(createRecords).mockRejectedValueOnce(new Error("audit down"));
    const r = await set();
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(row(S1)[SE.tanggal]).toBe("2026-11-10");
  });
  it("no PII or names in the audit rows", async () => {
    await set();
    expect(JSON.stringify(store[T.auditKep])).not.toMatch(/@x\.id.*Pertemuan/);
  });
});

describe("effects of a date change (I7)", () => {
  it("the absen list, the hub and getJadwal see the new date at once (caches invalidated)", async () => {
    store[T.eventKep].find((r) => r.id === KEP_OK)!.fields[F.eventKep.tanggalMulai] = "2026-11-10";
    await listPertemuan(pic, KEP_OK); // warm the cache
    await getKepHub(pic, KEP_OK);
    expect((await set({ tanggal: "2026-12-01" }, pic, { id: KEP_OK, sid: SOK })).status).toBe(200);
    expect((await listPertemuan(pic, KEP_OK)).items[0].tanggal).toBe("2026-12-01");
    expect((await getAbsenSheet(pic, KEP_OK, SOK)).subEvent.tanggal).toBe("2026-12-01");
    expect((await getKepHub(pic, KEP_OK)).pertemuan[0].tanggal).toBe("2026-12-01");
    expect((await getJadwal(sep, KEP_OK)).pertemuan[0].tanggal).toBe("2026-12-01");
  });
  it("getJadwal reports what each role may edit: PIC dates after approval, pewarta locked; Ditolak locks both", async () => {
    const a = await getJadwal(pic, KEP);
    expect(a.terkunci).toBe(false);
    expect(a.waktuTerkunci).toBe(false);
    const b = await getJadwal(pic, KEP_OK);
    expect(b.terkunci).toBe(true);
    expect(b.waktuTerkunci).toBe(false);
    const c = await getJadwal(sep, KEP_X);
    expect(c.terkunci).toBe(true);
    expect(c.waktuTerkunci).toBe(true);
  });
  it("the jadwal list exposes jam mulai/selesai", async () => {
    await set();
    const j = await getJadwal(pic, KEP);
    expect(j.pertemuan.find((p) => p.id === S1)).toMatchObject({ tanggal: "2026-11-12", jamMulai: "19:00", jamSelesai: "21:00" });
  });
});

describe("N2: PIC date guards (SEP exempt)", () => {
  const P = F.pendaftaranEvents;
  const early = () => (store[T.eventKep].find((k) => k.id === KEP)!.fields[F.eventKep.tanggalMulai] = "2026-11-01");
  const peserta = (extra: Record<string, unknown>) =>
    store[T.pendaftaranEvents].push({ id: `recPEND${store[T.pendaftaranEvents].length}`.padEnd(17, "0"), fields: { [P.event]: [EV], [P.teamUmat]: ["recTEAM0000000001"], [P.statusPendaftaran]: "Daftar", [P.kategoriKepesertaan]: "Peserta", ...extra } });
  beforeEach(() => {
    early();
    store[T.pendaftaranEvents] = [];
    store[T.teamUmat] = [{ id: "recTEAM0000000001", fields: { [F.teamUmat.namaLengkap]: "A" } }];
  });
  const msg = async (r: Response) => ((await r.json()) as { error?: string }).error ?? "";

  it("a future meeting cannot be moved into the past, nor to today (abuse: move the last meeting to today to unlock Hasil akhir)", async () => {
    for (const [i, d] of ["2026-11-07", "2026-11-08", "2026-11-03"].entries()) {
      const r = await set({ tanggal: d, opId: `op-jadwal-p${i}0001` });
      expect(r.status, d).toBe(409);
      expect(await msg(r)).toMatch(/tanggal.*(lewat|hari ini)/i);
    }
    expect(row(S1)[SE.tanggal]).toBe("2026-11-10");
    expect((await set({ tanggal: "2026-11-09", opId: "op-jadwal-ok0001" })).status).toBe(200); // tomorrow is fine
  });
  it("a meeting whose date has passed cannot be moved by the PIC", async () => {
    vi.setSystemTime(new Date("2026-11-11T05:00:00Z"));
    const r = await set({ tanggal: "2026-11-20" });
    expect(r.status).toBe(409);
    expect(await msg(r)).toMatch(/sudah lewat/i);
    expect(row(S1)[SE.tanggal]).toBe("2026-11-10");
  });
  it("a meeting with a hadir mark cannot be moved by the PIC, but its time can be changed on the same date", async () => {
    peserta({ [P.pertemuanHadir]: [S1] });
    const r = await set({ tanggal: "2026-11-12" });
    expect(r.status).toBe(409);
    expect(await msg(r)).toMatch(/kehadiran/i);
    expect((await set({ tanggal: "2026-11-10", jamMulai: "18:00", jamSelesai: "19:00", opId: "op-jadwal-jam001" })).status).toBe(200);
  });
  it("once any LULUS / TIDAK LULUS result exists the PIC cannot move any date", async () => {
    peserta({ [P.keterangan]: "LULUS" });
    const r = await set({ tanggal: "2026-11-12" }, pic, { id: KEP, sid: S2 });
    expect(r.status).toBe(409);
    expect(await msg(r)).toMatch(/hasil akhir/i);
  });
  it("SEP is exempt (past meeting, hadir marks, results, to today) and the audit carries the role", async () => {
    peserta({ [P.pertemuanHadir]: [S1], [P.keterangan]: "TIDAK LULUS" });
    vi.setSystemTime(new Date("2026-11-11T05:00:00Z"));
    expect((await set({ tanggal: "2026-11-11" }, sep)).status).toBe(200);
    expect(JSON.parse(String(auditOf("jadwal_set")[0].fields[AU.sesudah])).role).toBe("SEP");
  });
});
