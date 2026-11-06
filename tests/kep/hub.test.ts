import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn() }));

import { listRecords } from "@/lib/airtable/client";
import { getKepHub, listKepIndex } from "@/lib/kep/hub";
import { clearSessionCache, type Session } from "@/lib/auth/session";

const P = F.pendaftaranEvents;
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const admB: Session = { accountId: "recADMB000000001", email: "admb@x.id", role: "ADMIN", parokiId: PB };
const KEP = "recKEPA0000000001";
const KEP_B = "recKEPB0000000001";
const EV = "recEVA00000000001";
const EV_B = "recEVB00000000001";
const SECRET_HEALTH = "Diabetes tipe 2 SANGAT-RAHASIA";
const wib = (d: number) => new Date(Date.now() + 7 * 3600_000 + d * 86_400_000).toISOString().slice(0, 10);

const pend = (id: string, tu: string, o: Record<string, unknown> = {}, ev = EV) => ({
  id,
  fields: { [P.event]: [ev], [P.teamUmat]: [tu], [P.statusPendaftaran]: "Daftar", [P.kategoriKepesertaan]: "Peserta", [P.riwayatPenyakit]: SECRET_HEALTH, [P.kontakDarurat]: "Ibu 0812-RAHASIA", ...o },
});

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  resetStore();
  clearSessionCache();
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [F.akunKep.paroki]: [PA] } });
  store[T.penyelenggaraKep] = [
    { id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: "recORGB0000000001", fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  store[T.events] = [
    { id: EV, fields: { [F.events.namaAcara]: "KEP PAROKI A Angkatan 3" } },
    { id: EV_B, fields: { [F.events.namaAcara]: "KEP PAROKI B Angkatan 1" } },
  ];
  store[T.eventKep] = [
    { id: KEP, fields: { [F.eventKep.events]: [EV], [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.statusPersetujuan]: "Disetujui", [F.eventKep.angkatan]: 3, [F.eventKep.tanggalMulai]: wib(-8), [F.eventKep.tanggalSelesai]: wib(190) } },
    { id: KEP_B, fields: { [F.eventKep.events]: [EV_B], [F.eventKep.penyelenggara]: ["recORGB0000000001"], [F.eventKep.statusPersetujuan]: "Diajukan", [F.eventKep.angkatan]: 1 } },
  ];
  store[T.subEvent] = [
    { id: "recSUB1000000001", fields: { [F.subEvent.acara]: [EV], [F.subEvent.agenda]: "Pertemuan 1", [F.subEvent.urutan]: 1, [F.subEvent.tanggal]: wib(-7), [F.subEvent.pengajar]: ["recPENGAJAR000001"] } },
    { id: "recSUB2000000001", fields: { [F.subEvent.acara]: [EV], [F.subEvent.agenda]: "Pertemuan 2", [F.subEvent.urutan]: 2, [F.subEvent.tanggal]: wib(0) } },
    { id: "recSUB3000000001", fields: { [F.subEvent.acara]: [EV], [F.subEvent.agenda]: "Pertemuan 3", [F.subEvent.urutan]: 3, [F.subEvent.tanggal]: wib(7) } },
    { id: "recSUBB000000001", fields: { [F.subEvent.acara]: [EV_B], [F.subEvent.agenda]: "Paroki B", [F.subEvent.urutan]: 1, [F.subEvent.tanggal]: wib(0) } },
  ];
  const names = ["Agnes", "Bernadus", "Cecilia", "Dominikus", "Elisabeth", "Fransiskus", "Gabriella"];
  store[T.teamUmat] = [
    ...names.map((n, i) => ({ id: `recTEAM00000000${i + 1}`.padEnd(17, "0"), fields: { [F.teamUmat.namaLengkap]: n, [F.teamUmat.noWhatsapp]: "628123RAHASIA" } })),
    { id: "recTEAMB000000001", fields: { [F.teamUmat.namaLengkap]: "Orang Paroki B" } },
  ];
  const t = (i: number) => `recTEAM00000000${i}`.padEnd(17, "0");
  store[T.pendaftaranEvents] = [
    pend("recPEND0000000001", t(1), { [P.pertemuanHadir]: ["recSUB1000000001", "recSUB2000000001"] }),
    pend("recPEND0000000002", t(2), { [P.pertemuanHadir]: ["recSUB1000000001"] }),
    pend("recPEND0000000003", t(3), { [P.keterangan]: "MENGUNDURKAN DIRI", [P.pertemuanHadir]: ["recSUB1000000001"] }),
    pend("recPEND0000000004", t(4), { [P.keterangan]: "LULUS" }),
    pend("recPEND0000000005", t(5), { [P.keterangan]: "TIDAK LULUS" }),
    pend("recPEND0000000006", t(6), { [P.statusPendaftaran]: "Batal" }),
    pend("recPEND0000000007", t(7), { [P.kategoriKepesertaan]: "Panitia" }),
    pend("recPENDB000000001", "recTEAMB000000001", {}, EV_B),
  ];
  store[T.auditKep] = [];
  vi.mocked(listRecords).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("getKepHub", () => {
  it("PIC: name, angkatan, status, dates, stats and peserta (names, status and an incomplete flag only)", async () => {
    const h = await getKepHub(pic, KEP);
    expect(h).toMatchObject({ id: KEP, nama: "KEP PAROKI A Angkatan 3", angkatan: 3, status: "Disetujui", kelola: true });
    expect(h.tanggalMulai).toBe(wib(-8));
    expect(h.tanggalSelesai).toBe(wib(190));
    // Batal and Panitia are not peserta. Aktif = not mundur, not decided.
    expect(h.statistik).toEqual({ aktif: 2, mundur: 1, lulus: 1, tidakLulus: 1, total: 5 });
    expect(h.peserta).toEqual([
      { id: "recPEND0000000001", nama: "Agnes", status: "Aktif", belumLengkap: true },
      { id: "recPEND0000000002", nama: "Bernadus", status: "Aktif", belumLengkap: true },
      { id: "recPEND0000000003", nama: "Cecilia", status: "Mundur", belumLengkap: true },
      { id: "recPEND0000000004", nama: "Dominikus", status: "Lulus", belumLengkap: true },
      { id: "recPEND0000000005", nama: "Elisabeth", status: "Tidak lulus", belumLengkap: true },
    ]);
  });
  it("lists pertemuan with dates, hadir counts among non-mundur peserta, and flags today", async () => {
    const h = await getKepHub(pic, KEP);
    expect(h.pertemuan.map((p) => [p.urutan, p.agenda, p.tanggal, p.hadir])).toEqual([
      [1, "Pertemuan 1", wib(-7), 2],
      [2, "Pertemuan 2", wib(0), 1],
      [3, "Pertemuan 3", wib(7), 0],
    ]);
    expect(h.pertemuan.map((p) => p.pengajarDitugaskan)).toEqual([true, false, false]);
    expect(h.pertemuan.filter((p) => p.hariIni).map((p) => p.id)).toEqual(["recSUB2000000001"]);
    expect(h.pertemuanBerikutnya).toBe("recSUB2000000001");
  });
  it("never requests, returns or leaks health data, contact data or phone numbers", async () => {
    const h = await getKepHub(pic, KEP);
    const json = JSON.stringify(h);
    for (const leak of [SECRET_HEALTH, "RAHASIA", "0812"]) expect(json).not.toContain(leak);
    const asked = vi.mocked(listRecords).mock.calls.flatMap((c) => (c[1] as { fields?: string[] } | undefined)?.fields ?? []);
    for (const f of [P.riwayatPenyakit, P.riwayatAlergi, P.obatRutin, P.kontakDarurat, P.pendukungDoa, F.teamUmat.noWhatsapp]) expect(asked).not.toContain(f);
    // the e-mail is read only to know whether it exists ("Data belum lengkap"); its value never leaves the read model
    expect(json).not.toMatch(/@/);
  });
  it("SEP: read-only aggregates, no peserta list, no management links", async () => {
    const h = await getKepHub(sep, KEP);
    expect(h.kelola).toBe(false);
    expect(h.peserta).toBeUndefined();
    expect(h.statistik.total).toBe(5);
    expect(h.pertemuan[0].hadir).toBe(2);
    expect(JSON.stringify(h)).not.toMatch(/Agnes|Bernadus/);
  });
  it("cross-parish and unknown ids are 404; malformed ids too", async () => {
    await expect(getKepHub(admB, KEP)).rejects.toMatchObject({ status: 404 });
    await expect(getKepHub(pic, KEP_B)).rejects.toMatchObject({ status: 404 });
    await expect(getKepHub(pic, "recNOSUCHKEP00001")).rejects.toMatchObject({ status: 404 });
    await expect(getKepHub(pic, "../x")).rejects.toMatchObject({ status: 404 });
  });
  it("a KEP that is not yet Disetujui still shows, with kelola true but absen not available", async () => {
    const h = await getKepHub(admB, KEP_B);
    expect(h.status).toBe("Diajukan");
    expect(h.absenTersedia).toBe(false);
    expect((await getKepHub(pic, KEP)).absenTersedia).toBe(true);
  });
  it("pewarta assignment is open only while Diajukan; only the PIC may use it", async () => {
    expect((await getKepHub(admB, KEP_B)).jadwalTerkunci).toBe(false);
    expect((await getKepHub(pic, KEP)).jadwalTerkunci).toBe(true);
    expect((await getKepHub(pic, KEP)).pic).toBe(true);
    expect((await getKepHub(admB, KEP_B)).pic).toBe(false);
    expect((await getKepHub(sep, KEP)).pic).toBe(false);
  });
});

describe("listKepIndex", () => {
  it("PIC sees only the own parish, SEP sees all, each with name/angkatan/status", async () => {
    const mine = await listKepIndex(pic);
    expect(mine.map((k) => k.id)).toEqual([KEP]);
    expect(mine[0]).toMatchObject({ nama: "KEP PAROKI A Angkatan 3", angkatan: 3, status: "Disetujui" });
    const all = await listKepIndex(sep);
    expect(all.map((k) => k.id).sort()).toEqual([KEP, KEP_B].sort());
  });
});
