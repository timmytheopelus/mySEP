import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import { listRecords } from "@/lib/airtable/client";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { kehadiranPerPertemuan, profilPeserta, rekapAngkatan, toCsv, trenTahunan } from "@/lib/kep/reports";
import { GET } from "@/app/api/laporan/[jenis]/route";
import { SESSION_COOKIE, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const P = F.pendaftaranEvents;
const U = F.teamUmat;
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const adm: Session = { accountId: "recADM0000000001", email: "adm@x.id", role: "ADMIN", parokiId: PA };
const KEP_A1 = "recKEPA1000000001";
const KEP_A2 = "recKEPA2000000001";
const KEP_B = "recKEPB1000000001";
const EV_A1 = "recEVA1000000001";
const EV_A2 = "recEVA2000000001";
const EV_B = "recEVB1000000001";
const EV_L = "recEVL1000000001";
const S1 = "recSUB1000000001";
const S2 = "recSUB2000000001";
const S3 = "recSUB3000000001";
const yr = new Date().getFullYear();
const pid = (n: number) => `recPEND${String(n).padStart(9, "0")}`;
const tid = (n: number) => `recTEAM${String(n).padStart(9, "0")}`;

type Spec = { n: number; ket?: string; status?: string; kat?: string; hadir?: string[]; ev?: string; jk?: string; nikah?: string; lahir?: string };
function seedPeserta(specs: Spec[]) {
  for (const s of specs) {
    (store[T.teamUmat] ??= []).push({
      id: tid(s.n),
      fields: { [U.namaLengkap]: `Nama Rahasia ${s.n}`, [U.noWhatsapp]: `0812000${String(s.n).padStart(4, "0")}`, [U.email]: `p${s.n}@rahasia.id`, ...(s.jk ? { [U.jenisKelamin]: s.jk } : {}), ...(s.nikah ? { [U.statusPernikahan]: s.nikah } : {}), ...(s.lahir ? { [U.tanggalLahir]: s.lahir } : {}) },
    });
    (store[T.pendaftaranEvents] ??= []).push({
      id: pid(s.n),
      fields: { [P.event]: [s.ev ?? EV_A1], [P.teamUmat]: [tid(s.n)], [P.statusPendaftaran]: s.status ?? "Daftar", [P.kategoriKepesertaan]: s.kat ?? "Peserta", ...(s.ket ? { [P.keterangan]: s.ket } : {}), ...(s.hadir ? { [P.pertemuanHadir]: s.hadir } : {}), [P.riwayatPenyakit]: "KANKER-RAHASIA" },
    });
  }
}

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  await seedAccount({ id: sep.accountId, email: sep.email, peran: "SEP" });
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [F.akunKep.paroki]: [PA] } });
  await seedAccount({ id: adm.accountId, email: adm.email, peran: "Admin Paroki", fields: { [F.akunKep.paroki]: [PA] } });
  store[T.paroki] = [
    { id: PA, fields: { [F.paroki.nama]: "Pandu" } },
    { id: PB, fields: { [F.paroki.nama]: "Katedral" } },
  ];
  store[T.penyelenggaraKep] = [
    { id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: "recORGB0000000001", fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  const ev = (id: string, nama: string, tgl: string) => ({ id, fields: { [F.events.namaAcara]: nama, [F.events.kelompokAcara]: "KEP", [F.events.tanggalAcara]: tgl } });
  store[T.events] = [
    ev(EV_A1, "KEP PAROKI Pandu Angkatan 1", "2024-03-01"),
    ev(EV_A2, "KEP PAROKI Pandu Angkatan 2", "2025-03-01"),
    ev(EV_B, "KEP PAROKI Katedral Angkatan 1", "2025-04-01"),
    ev(EV_L, "KEP PAROKI Lama Angkatan 4", "2020-01-01"),
  ];
  const kep = (id: string, e: string, org: string, st = "Disetujui") => ({ id, fields: { [F.eventKep.events]: [e], [F.eventKep.penyelenggara]: [org], [F.eventKep.statusPersetujuan]: st } });
  store[T.eventKep] = [kep(KEP_A1, EV_A1, "recORGA0000000001"), kep(KEP_A2, EV_A2, "recORGA0000000001"), kep(KEP_B, EV_B, "recORGB0000000001")];
  const sub = (id: string, ev: string, n: number, tgl: string, agenda = `Pertemuan ${n}`) => ({ id, fields: { [F.subEvent.acara]: [ev], [F.subEvent.agenda]: agenda, [F.subEvent.urutan]: n, [F.subEvent.tanggal]: tgl } });
  store[T.subEvent] = [sub(S1, EV_A1, 1, "2024-03-01"), sub(S2, EV_A1, 2, "2024-03-08"), sub(S3, EV_A1, 3, "2024-03-15", "=HYPERLINK(evil)")];
  store[T.teamUmat] = [];
  store[T.pendaftaranEvents] = [];
  seedPeserta([2, 3, 4, 5, 6].map((n) => ({ n, ket: "LULUS" })));
  seedPeserta([
    { n: 1, ket: "LULUS", hadir: [S1, S2], jk: "Perempuan", nikah: "Menikah", lahir: `${yr - 35}-01-01` },
    { n: 7, ket: "TIDAK LULUS" },
    { n: 8, ket: "MENGUNDURKAN DIRI", hadir: [S1] },
    { n: 9, ket: "  lulus " },
    { n: 10, status: "Batal", ket: "LULUS" },
    { n: 11, kat: "Panitia", ket: "LULUS" },
    { n: 12, hadir: [S1, S2, S3] },
    { n: 13, ket: "MENGUNDURKAN DIRI", hadir: [S1] },
    { n: 14, ev: EV_A2, ket: "LULUS" },
    { n: 15, ev: EV_A2 },
    { n: 21, ev: EV_B, ket: "LULUS" },
    { n: 22, ev: EV_B, ket: "LULUS" },
    { n: 23, ev: EV_B, ket: "LULUS" },
    { n: 31, ev: EV_L, ket: "LULUS" },
    { n: 32, ev: EV_L, ket: "LULUS" },
  ]);
  store[T.auditKep] = [
    // peserta 8 withdrew on 2024-03-08 (WIB): aktif for pertemuan 1 and 2, not 3. Peserta 13 has no audit row.
    { id: "recAUD0000000001", fields: { [F.auditKep.aksi]: "peserta_mundur", [F.auditKep.targetId]: pid(8), [F.auditKep.sesudah]: JSON.stringify({ opId: "op1", t: Date.parse("2024-03-08T10:00:00+07:00") }) } },
  ];
  invalidateKepCache();
  vi.mocked(listRecords).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("rekapAngkatan", () => {
  it("counts lulus from Keterangan only (normalised), mundur never lulus, attendance irrelevant", async () => {
    const r = await rekapAngkatan({ parokiId: PA });
    const a1 = r.find((x) => x.angkatan === 1)!;
    // 1-6 (6) + n9 "  lulus " = 7 lulus; n12 attended everything but is not lulus; Batal and Panitia excluded
    expect(a1).toEqual({ paroki: "Pandu", angkatan: 1, peserta: 11, lulus: 7, tidakLulus: 1, mundur: 2 });
  });
  it("parish A scope never returns parish B or unmapped rows", async () => {
    const r = await rekapAngkatan({ parokiId: PA });
    expect(r.map((x) => x.paroki)).toEqual(["Pandu", "Pandu"]);
    expect(JSON.stringify(r)).not.toMatch(/Katedral|Belum terpetakan/);
  });
  it("SEP sees all parishes plus the 'Belum terpetakan' bucket without error", async () => {
    const r = await rekapAngkatan({ parokiId: "ALL" });
    expect(r.map((x) => x.paroki).sort()).toEqual(["Belum terpetakan", "Katedral", "Pandu", "Pandu"]);
    expect(r.find((x) => x.paroki === "Belum terpetakan")).toMatchObject({ angkatan: 4, peserta: 2, lulus: 2 });
  });
  it("tolerates malformed legacy rows", async () => {
    store[T.pendaftaranEvents].push({ id: "recPSBAD000000001", fields: {} });
    store[T.events].push({ id: "recEVBAD000000001", fields: { [F.events.kelompokAcara]: "KEP" } });
    await expect(rekapAngkatan({ parokiId: "ALL" })).resolves.toBeTruthy();
  });
  it("rejects a malformed scope", async () => {
    await expect(rekapAngkatan({ parokiId: "x" as never })).rejects.toThrow();
  });
});

describe("cache per scope", () => {
  it("never serves one scope from another's entry, and reuses the same scope's entry", async () => {
    const a = await rekapAngkatan({ parokiId: PA });
    const all = await rekapAngkatan({ parokiId: "ALL" });
    const b = await rekapAngkatan({ parokiId: PB });
    const a2 = await rekapAngkatan({ parokiId: PA });
    expect(a.length).toBe(2);
    expect(all.length).toBe(4);
    expect(b.map((x) => x.paroki)).toEqual(["Katedral"]);
    expect(a2).toEqual(a);
    const calls = vi.mocked(listRecords).mock.calls.length;
    await rekapAngkatan({ parokiId: PA });
    expect(vi.mocked(listRecords).mock.calls.length).toBe(calls);
  });
  it("is dropped after invalidateKepCache", async () => {
    await rekapAngkatan({ parokiId: PA });
    store[T.pendaftaranEvents].find((p) => p.id === pid(7))!.fields[P.keterangan] = "LULUS";
    invalidateKepCache();
    const a1 = (await rekapAngkatan({ parokiId: PA })).find((x) => x.angkatan === 1)!;
    expect(a1.lulus).toBe(8);
  });
});

describe("trenTahunan", () => {
  it("groups by year, scoped", async () => {
    expect(await trenTahunan({ parokiId: PA })).toEqual([
      { tahun: 2024, angkatan: 1, peserta: 11, lulus: 7 },
      { tahun: 2025, angkatan: 1, peserta: 2, lulus: 1 },
    ]);
    const all = await trenTahunan({ parokiId: "ALL" });
    expect(all.find((x) => x.tahun === 2025)).toEqual({ tahun: 2025, angkatan: 2, peserta: 5, lulus: 4 });
  });
});

describe("kehadiranPerPertemuan", () => {
  it("counts mundur as aktif only up to the audit date of peserta_mundur; none without audit", async () => {
    const r = await kehadiranPerPertemuan(pic, KEP_A1);
    expect(r).toEqual([
      { agenda: "Pertemuan 1", tanggal: "2024-03-01", hadir: 3, aktif: 10 },
      { agenda: "Pertemuan 2", tanggal: "2024-03-08", hadir: 2, aktif: 10 },
      { agenda: "=HYPERLINK(evil)", tanggal: "2024-03-15", hadir: 1, aktif: 9 },
    ]);
  });
  it("PIC of another parish gets 404, SEP may read any", async () => {
    await expect(kehadiranPerPertemuan(pic, KEP_B)).rejects.toMatchObject({ status: 404 });
    await expect(kehadiranPerPertemuan(sep, KEP_B)).resolves.toBeTruthy();
    await expect(kehadiranPerPertemuan(pic, "bukan-id")).rejects.toMatchObject({ status: 404 });
  });
});

describe("profilPeserta", () => {
  it("aggregates only, suppresses buckets < 5 and the complementary one", async () => {
    // 13 distinct counted peserta in Pandu (11 in angkatan 1 + 2 in angkatan 2): assign demographics
    const counted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15];
    counted.forEach((n, i) => {
      const f = store[T.teamUmat].find((t) => t.id === tid(n))!.fields;
      f[U.jenisKelamin] = i < 8 ? "Perempuan" : "Laki-laki"; // 8 / 5: nothing suppressed
      f[U.statusPernikahan] = i < 7 ? "Menikah" : i < 12 ? "Lajang" : "Duda"; // 7 / 5 / 1: Duda + next smallest (Lajang)
      f[U.tanggalLahir] = i < 6 ? `${yr - 35}-01-01` : i < 12 ? `${yr - 45}-01-01` : `${yr - 65}-01-01`; // 6 / 6 / 1
    });
    invalidateKepCache();
    const p = await profilPeserta({ parokiId: PA });
    expect(p.jenisKelamin).toEqual({ Perempuan: 8, "Laki-laki": 5 });
    expect(p.statusPernikahan).toEqual({ Menikah: 7, Lajang: "<5", Duda: "<5" });
    expect(p.kelompokUsia["60+"]).toBe("<5");
    expect(p.kelompokUsia["30-39"]).toBe("<5"); // complementary (first of the tied smallest)
    expect(p.kelompokUsia["40-49"]).toBe(6);
    const s = JSON.stringify(p);
    for (const leak of ["Rahasia", "0812", "@rahasia", "KANKER"]) expect(s).not.toContain(leak);
  });
  it("never leaks counts of 1-4 as numbers", async () => {
    const p = await profilPeserta({ parokiId: "ALL" });
    for (const dim of [p.kelompokUsia, p.jenisKelamin, p.statusPernikahan])
      for (const v of Object.values(dim)) expect(typeof v === "number" ? v === 0 || v >= 5 : v === "<5").toBe(true);
  });
});

describe("toCsv", () => {
  it("neutralises every cell and header, quotes specials", () => {
    const out = toCsv([{ "=cmd": "a", b: "=1+1", c: "+x", d: '-y"z', e: "@w", f: "a,b", g: 5 }]);
    expect(out.split("\r\n")[0]).toBe("'=cmd,b,c,d,e,f,g");
    expect(out.split("\r\n")[1]).toBe(`a,'=1+1,'+x,"'-y""z",'@w,"a,b",5`);
  });
  it("is empty for no rows", () => expect(toCsv([])).toBe(""));
});

async function get(jenis: string, qs = "", as?: Session) {
  const req = new Request(`https://kep.test/api/laporan/${jenis}${qs}`, {
    headers: { "x-real-ip": "10.2.0.1", ...(as ? { cookie: `${SESSION_COOKIE}=${await issueSession(as, { amr: ["pwd", "otp"] })}` } : {}) },
  });
  return (GET as unknown as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve({ jenis }) });
}

describe("GET /api/laporan/[jenis]", () => {
  it("requires login", async () => expect((await get("rekap-angkatan")).status).toBe(401));
  it("only allowlisted jenis", async () => {
    for (const j of ["rekap", "constructor", "..%2Fx", "peserta", "Rekap-Angkatan"]) expect((await get(j, "", sep)).status).toBe(404);
  });
  it("PIC gets own parish only; SEP gets everything", async () => {
    const a = await (await get("rekap-angkatan", "", pic)).json();
    expect(a.data.map((x: { paroki: string }) => x.paroki)).toEqual(["Pandu", "Pandu"]);
    const s = await (await get("rekap-angkatan", "", sep)).json();
    expect(s.data).toHaveLength(4);
    const ad = await get("tren", "", adm);
    expect(ad.status).toBe(200);
  });
  it("a PIC cannot widen the scope with ?paroki= (other parish is 404), SEP can narrow", async () => {
    expect((await get("rekap-angkatan", `?paroki=${PB}`, pic)).status).toBe(404);
    expect((await get("profil", `?paroki=${PB}`, adm)).status).toBe(404);
    expect((await get("rekap-angkatan", `?paroki=${PA}`, pic)).status).toBe(200);
    const s = await (await get("rekap-angkatan", `?paroki=${PB}`, sep)).json();
    expect(s.data.map((x: { paroki: string }) => x.paroki)).toEqual(["Katedral"]);
  });
  it("kehadiran needs a KEP in scope: cross-parish 404, missing 422", async () => {
    expect((await get("kehadiran", `?kep=${KEP_B}`, pic)).status).toBe(404);
    expect((await get("kehadiran", "", pic)).status).toBe(422);
    expect((await get("kehadiran", `?kep=${KEP_A1}`, pic)).status).toBe(200);
  });
  it("CSV: BOM, neutralised, attachment, no-store, no personal data, audit with ids only", async () => {
    const res = await get("kehadiran", `?kep=${KEP_A1}&format=csv`, pic);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="laporan-kehadiran.csv"');
    expect(res.headers.get("cache-control")).toContain("no-store");
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await res.text();
    expect(text).toContain("agenda,tanggal,hadir,aktif");
    expect(text).toContain("'=HYPERLINK(evil)");
    for (const leak of ["Rahasia", "0812", "KANKER", "@rahasia"]) expect(text).not.toContain(leak);
    const log = store[T.auditKep].find((r) => r.fields[F.auditKep.aksi] === "laporan_unduh")!;
    expect(log).toBeTruthy();
    expect(log.fields[F.auditKep.targetId]).toBe("kehadiran");
    expect(JSON.stringify(log.fields)).not.toMatch(/Rahasia|Pertemuan/);
  });
  it("json is no-store too, and a bad format is 422", async () => {
    expect((await get("tren", "", pic)).headers.get("cache-control")).toContain("no-store");
    expect((await get("tren", "?format=xml", pic)).status).toBe(422);
  });
  it("CSV of profil carries suppressed markers and no unmapped bucket for a PIC", async () => {
    const t = await (await get("rekap-angkatan", "?format=csv", pic)).text();
    expect(t).not.toContain("Belum terpetakan");
    const s = await (await get("rekap-angkatan", "?format=csv", sep)).text();
    expect(s).toContain("Belum terpetakan");
  });
  it("rate limits per actor", async () => {
    let last = 200;
    for (let i = 0; i < 40; i++) last = (await get("tren", "", pic)).status;
    expect(last).toBe(429);
    expect((await get("tren", "", sep)).status).toBe(200);
  });
});
