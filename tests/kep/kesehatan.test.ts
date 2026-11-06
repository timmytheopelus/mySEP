import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { EVENT_ID_FIELD, F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import { getKesehatan } from "@/lib/kep/kesehatan";
import { getKepHub } from "@/lib/kep/hub";
import { getJadwal } from "@/lib/kep/jadwal";
import { getAbsenSheet, getPenetapanSheet, listPertemuan } from "@/lib/kep/absensi";
import { HttpError } from "@/lib/http/errors";
import type { Session } from "@/lib/auth/session";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { resetRateLimitMemory } from "@/lib/ratelimit";
import { clearSessionCache } from "@/lib/auth/session";
import { listRecords } from "@/lib/airtable/client";
import nextConfig from "../../next.config";

const A = F.akunKep;
const P = F.pendaftaranEvents;
const U = F.teamUmat;
const AU = F.auditKep;
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const adm: Session = { accountId: "recADMA000000001", email: "adma@x.id", role: "ADMIN", parokiId: PA };
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const picB: Session = { accountId: "recPICB000000001", email: "picb@x.id", role: "PIC", parokiId: PB };
const KEP = "recKEPA0000000001";
const KEP_B = "recKEPB0000000001";
const EV = "recEVA00000000001";
const EV_B = "recEVB00000000001";
const SECRET = ["ASMA-BERAT", "ALERGI-UDANG", "OBAT-VENTOLIN", "IBU-0899-KONTAK"];

const peserta = (id: string, tid: string, extra: Record<string, unknown> = {}, ev = EV) => ({
  id,
  fields: { [P.event]: [ev], [P.teamUmat]: [tid], [P.statusPendaftaran]: "Daftar", [P.kategoriKepesertaan]: "Peserta", ...extra },
});
const status = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return e instanceof HttpError ? e.status : 500;
  }
};

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  invalidateKepCache();
  await seedAccount({ id: sep.accountId, email: sep.email, peran: "SEP" });
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: adm.accountId, email: adm.email, peran: "Admin Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: picB.accountId, email: picB.email, peran: "PIC Paroki", fields: { [A.paroki]: [PB] } });
  store[T.penyelenggaraKep] = [
    { id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: "recORGB0000000001", fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  store[T.eventKep] = [
    { id: KEP, fields: { [F.eventKep.events]: [EV], [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.statusPersetujuan]: "Disetujui" } },
    { id: KEP_B, fields: { [F.eventKep.events]: [EV_B], [F.eventKep.penyelenggara]: ["recORGB0000000001"], [F.eventKep.statusPersetujuan]: "Disetujui" } },
  ];
  store[T.events] = [
    { id: EV, fields: { [F.events.namaAcara]: "KEP Paroki A", [EVENT_ID_FIELD]: "2611-A" } },
    { id: EV_B, fields: { [F.events.namaAcara]: "KEP Paroki B", [EVENT_ID_FIELD]: "2611-B" } },
  ];
  store[T.subEvent] = [{ id: "recSUB1000000001", fields: { [F.subEvent.acara]: [EV], [F.subEvent.agenda]: "Bab 1", [F.subEvent.urutan]: 1, [F.subEvent.tanggal]: "2026-11-07" } }];
  store[T.teamUmat] = ["Agnes", "Bernadus", "Cecilia", "Dominikus", "Elisabeth", "Fransiskus"].map((n, i) => ({
    id: `recTEAM000000000${i + 1}`,
    fields: { [U.namaLengkap]: n, [U.noWhatsapp]: `628111111111${i}`, [U.email]: `${n.toLowerCase()}@x.id`, [U.tanggalLahir]: "1980-01-01" },
  }));
  store[T.pendaftaranEvents] = [
    peserta("recPEND0000000001", "recTEAM0000000001", { [P.riwayatPenyakit]: SECRET[0], [P.kontakDarurat]: SECRET[3] }),
    peserta("recPEND0000000002", "recTEAM0000000002", { [P.riwayatAlergi]: SECRET[1] }),
    peserta("recPEND0000000003", "recTEAM0000000003", { [P.obatRutin]: SECRET[2], [P.keterangan]: "MENGUNDURKAN DIRI" }), // mundur: shown dimmed
    peserta("recPEND0000000004", "recTEAM0000000004"), // nothing recorded -> not listed
    peserta("recPEND0000000005", "recTEAM0000000005", { [P.riwayatPenyakit]: "BATAL-SECRET", [P.statusPendaftaran]: "Batal" }), // not a peserta
    peserta("recPEND0000000006", "recTEAM0000000006", { [P.kontakDarurat]: "PANITIA-SECRET", [P.kategoriKepesertaan]: "Panitia" }),
    peserta("recPENDB000000001", "recTEAM0000000006", { [P.riwayatPenyakit]: "PAROKI-B-SECRET" }, EV_B),
  ];
  store[T.auditKep] = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("getKesehatan (data kesehatan screen)", () => {
  it("PIC and ADMIN of the parish see peserta with health notes or an emergency contact, with their text", async () => {
    for (const who of [pic, adm]) {
      resetRateLimitMemory();
      const k = await getKesehatan(who, KEP);
      expect(k.nama).toBe("KEP Paroki A");
      expect(k.items.map((i) => i.nama)).toEqual(["Agnes", "Bernadus", "Cecilia"]);
      expect(k.items[0]).toMatchObject({ riwayatPenyakit: SECRET[0], kontakDarurat: SECRET[3], mundur: false });
      expect(k.items[1]).toMatchObject({ riwayatAlergi: SECRET[1] });
      expect(k.items[2]).toMatchObject({ obatRutin: SECRET[2], mundur: true });
      const json = JSON.stringify(k);
      for (const hidden of ["BATAL-SECRET", "PANITIA-SECRET", "PAROKI-B-SECRET", "Dominikus"]) expect(json).not.toContain(hidden);
      expect(k.jumlahPeserta).toBe(4); // countable peserta of the KEP (Dominikus included), 3 listed
    }
  });
  it("SEP is refused (403) and no health field is ever requested for them", async () => {
    vi.mocked(listRecords).mockClear();
    expect(await status(() => getKesehatan(sep, KEP))).toBe(403);
    const asked = vi.mocked(listRecords).mock.calls.flatMap((c) => (c[1] as { fields?: string[] } | undefined)?.fields ?? []);
    for (const f of [P.riwayatPenyakit, P.riwayatAlergi, P.obatRutin, P.kontakDarurat]) expect(asked).not.toContain(f);
    expect(store[T.auditKep]).toHaveLength(0);
  });
  it("another parish: 404 (also for a malformed id), nothing audited", async () => {
    expect(await status(() => getKesehatan(picB, KEP))).toBe(404);
    expect(await status(() => getKesehatan(pic, KEP_B))).toBe(404);
    expect(await status(() => getKesehatan(pic, "nope"))).toBe(404);
    expect(store[T.auditKep]).toHaveLength(0);
  });
  it("audits data_kesehatan_dilihat with ids only, at most once per 10 minutes per actor and KEP", async () => {
    await getKesehatan(pic, KEP);
    await getKesehatan(pic, KEP); // reload: same window
    const rows = store[T.auditKep].filter((r) => r.fields[AU.aksi] === "data_kesehatan_dilihat");
    expect(rows).toHaveLength(1);
    expect(rows[0].fields[AU.pelaku]).toBe(pic.email);
    expect(rows[0].fields[AU.targetId]).toBe(KEP);
    const after = JSON.parse(String(rows[0].fields[AU.sesudah]));
    expect(after.pendaftaranIds).toEqual(["recPEND0000000001", "recPEND0000000002", "recPEND0000000003"]);
    const all = JSON.stringify(store[T.auditKep]);
    for (const s of [...SECRET, "Agnes", "Bernadus", "agnes@x.id"]) expect(all).not.toContain(s);
    // another actor of the same parish is a separate window; another KEP is not touched
    await getKesehatan(adm, KEP);
    expect(store[T.auditKep].filter((r) => r.fields[AU.aksi] === "data_kesehatan_dilihat")).toHaveLength(2);
  });
  it("a window of 10 minutes: after it the next view is audited again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await getKesehatan(pic, KEP);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await getKesehatan(pic, KEP);
    } finally {
      vi.useRealTimers();
    }
    expect(store[T.auditKep].filter((r) => r.fields[AU.aksi] === "data_kesehatan_dilihat")).toHaveLength(2);
  });
  it("when the audit row cannot be written nothing is returned (audit first)", async () => {
    const { createRecords } = await import("@/lib/airtable/client");
    vi.mocked(createRecords).mockRejectedValueOnce(new Error("audit down"));
    await expect(getKesehatan(pic, KEP)).rejects.toThrow();
  });
  it("SEP never sees health data on any other KEP screen (hub, jadwal, absen, penetapan)", async () => {
    const blob = JSON.stringify([
      await getKepHub(sep, KEP),
      await getJadwal(sep, KEP),
      await getKepHub(pic, KEP),
      await getJadwal(pic, KEP),
      await listPertemuan(pic, KEP),
      await getAbsenSheet(pic, KEP, "recSUB1000000001"),
      await getPenetapanSheet(pic, KEP).catch(() => null),
    ]);
    for (const s of SECRET) expect(blob).not.toContain(s);
  });
  it("the page response is never cached: next.config sends Cache-Control: no-store for /kep/:id/kesehatan", async () => {
    const rules = await nextConfig.headers!();
    const rule = rules.find((r) => r.source === "/kep/:id/kesehatan");
    expect(rule?.headers).toContainEqual({ key: "Cache-Control", value: "no-store" });
  });
});
