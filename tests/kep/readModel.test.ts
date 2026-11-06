import { beforeEach, describe, expect, it, vi } from "vitest";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, store } from "../helpers/fake-airtable";
import legacy from "./fixtures/legacy.json";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import { listRecords } from "@/lib/airtable/client";
import { EVENT_ID_FIELD } from "@/lib/airtable/schema";
import { invalidateKepCache, listKepEvents, listPesertaView, publicStats } from "@/lib/kep/readModel";
import type { Session } from "@/lib/auth/session";

type Row = { id: string; f: Record<string, unknown> };
const TABLES: Record<string, [string, Record<string, string>]> = {
  paroki: [T.paroki, F.paroki],
  penyelenggaraKep: [T.penyelenggaraKep, F.penyelenggaraKep],
  events: [T.events, F.events],
  eventKep: [T.eventKep, F.eventKep],
  teamUmat: [T.teamUmat, F.teamUmat],
  pendaftaranEvents: [T.pendaftaranEvents, F.pendaftaranEvents],
};
function load() {
  resetStore();
  for (const [k, [tid, fmap]] of Object.entries(TABLES)) {
    store[tid] = (legacy as unknown as Record<string, Row[]>)[k].map((r) => ({
      id: r.id,
      fields: Object.fromEntries(Object.entries(r.f).map(([n, v]) => [fmap[n], v])),
    }));
  }
  for (const ev of store[T.events]) ev.fields[EVENT_ID_FIELD] = `2601-${ev.fields[F.events.namaAcara]}`;
}

const LAUR = "recPARLAUR0000001";
const PANDU = "recPARPANDU0000001";
const sep: Session = { accountId: "recSEP00000000001", email: "s@x.id", role: "SEP", parokiId: null };
const picPandu: Session = { accountId: "recPIC00000000001", email: "p@x.id", role: "PIC", parokiId: PANDU };
const admLaur: Session = { accountId: "recADM00000000001", email: "a@x.id", role: "ADMIN", parokiId: LAUR };

beforeEach(() => {
  load();
  invalidateKepCache();
  vi.mocked(listRecords).mockClear();
});

describe("listKepEvents", () => {
  it("merges duplicate paroki+angkatan into the entry with most pendaftar, drops non-course events", async () => {
    const all = await listKepEvents({ parokiId: "ALL" });
    const laur = all.filter((e) => e.parokiId === LAUR && e.angkatan === 18);
    expect(laur).toHaveLength(1);
    expect(laur[0]).toMatchObject({ eventId: "recEVLAUR18B00001", pesertaCount: 2, status: "Disetujui", parokiNama: "St. Laurentius" });
    const names = JSON.stringify(all);
    expect(names).not.toContain("Pembekalan");
    expect(names).not.toContain("recEVBINALANJUT01");
    expect(all.find((e) => e.eventId === "recEVRETRET00001")).toBeUndefined();
  });

  it("puts rows without a parish in 'Belum terpetakan' without throwing; legacy rows are 'Lama'", async () => {
    const all = await listKepEvents({ parokiId: "ALL" });
    const k = all.find((e) => e.eventId === "recEVKATEDRAL0001")!;
    expect(k).toMatchObject({ parokiNama: "Belum terpetakan", parokiId: null, eventKepId: null, status: "Lama", angkatan: 3, tanggalMulai: "2022-05-05" });
    expect(all.find((e) => e.parokiId === PANDU)!.status).toBe("Disetujui");
  });

  it("counts peserta once per person (WA/email normalized), excluding Panitia and Batal", async () => {
    const all = await listKepEvents({ parokiId: "ALL" });
    expect(all.find((e) => e.eventId === "recEVLAUR18B00001")!.pesertaCount).toBe(2);
  });

  it("scopes to a paroki and never shows the unmapped bucket to a paroki", async () => {
    const r = await listKepEvents({ parokiId: PANDU });
    expect(r.map((e) => e.eventId)).toEqual(["recEVPANDU900001"]);
  });

  it("does not throw on malformed rows", async () => {
    store[T.events].push({ id: "recEVBAD000000001", fields: { [F.events.kelompokAcara]: "KEP" } });
    store[T.pendaftaranEvents].push({ id: "recPSBAD000000001", fields: {} });
    await expect(listKepEvents({ parokiId: "ALL" })).resolves.toBeTruthy();
  });
});

describe("publicStats", () => {
  it("returns only aggregate counts and parish names", async () => {
    const s = await publicStats();
    expect(s).toEqual({
      paroki: 2,
      angkatan: 3,
      lulusan: 4,
      daftarParoki: [
        { nama: "Paroki Pandu", angkatan: 9 },
        { nama: "St. Laurentius", angkatan: 18 },
      ],
    });
    const json = JSON.stringify(s);
    for (const leak of ["Budi", "Siti", "0812", "mail.com", "Asma", "Udang", "Ventolin"]) expect(json).not.toContain(leak);
    expect(Object.keys(s).sort()).toEqual(["angkatan", "daftarParoki", "lulusan", "paroki"]);
  });

  it("counts Daftar+LULUS Peserta as lulusan, ignoring Panitia, rejected and non-course events", async () => {
    expect((await publicStats()).lulusan).toBe(4);
  });

  it("is cached: a second call does not hit Airtable", async () => {
    await publicStats();
    const n = vi.mocked(listRecords).mock.calls.length;
    await publicStats();
    await publicStats();
    expect(vi.mocked(listRecords).mock.calls.length).toBe(n);
  });

  it("concurrent anonymous calls share a single fetch", async () => {
    await Promise.all(Array.from({ length: 20 }, () => publicStats()));
    const perTable = vi.mocked(listRecords).mock.calls.filter((c) => c[0] === T.events).length;
    expect(perTable).toBe(1);
  });

  it("serves the stale value if a refresh fails", async () => {
    vi.useFakeTimers();
    try {
      const first = await publicStats();
      vi.mocked(listRecords).mockRejectedValue(new Error("down"));
      vi.advanceTimersByTime(11 * 60_000);
      expect(await publicStats()).toEqual(first);
    } finally {
      vi.useRealTimers();
      vi.mocked(listRecords).mockImplementation(fakeClientModule().listRecords);
    }
  });
});

describe("table cache", () => {
  it("shares reads across calls until invalidated", async () => {
    await listKepEvents({ parokiId: "ALL" });
    const n = vi.mocked(listRecords).mock.calls.length;
    await listKepEvents({ parokiId: "ALL" });
    expect(vi.mocked(listRecords).mock.calls.length).toBe(n);
    invalidateKepCache(T.pendaftaranEvents);
    await listKepEvents({ parokiId: "ALL" });
    const again = vi.mocked(listRecords).mock.calls.slice(n).map((c) => c[0]);
    expect(again).toEqual([T.pendaftaranEvents]);
  });

  it("reads each table once per request (no N+1)", async () => {
    await listKepEvents({ parokiId: "ALL" });
    const tables = vi.mocked(listRecords).mock.calls.map((c) => c[0]);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it("expires after the short TTL", async () => {
    vi.useFakeTimers();
    try {
      await listKepEvents({ parokiId: "ALL" });
      const n = vi.mocked(listRecords).mock.calls.length;
      vi.advanceTimersByTime(61_000);
      await listKepEvents({ parokiId: "ALL" });
      expect(vi.mocked(listRecords).mock.calls.length).toBeGreaterThan(n);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("listPesertaView", () => {
  const P = F.pendaftaranEvents;
  it("PIC of the same paroki sees health data", async () => {
    const rows = await listPesertaView(picPandu);
    expect(rows).toHaveLength(1);
    expect(rows[0].kesehatan).toEqual({ riwayatPenyakit: "Asma", riwayatAlergi: "Udang", obatRutin: "Ventolin", kontakDarurat: "Ibu 0899" });
  });
  it("SEP never gets health data (keys absent, not just empty)", async () => {
    const rows = await listPesertaView(sep);
    expect(rows.length).toBeGreaterThan(3);
    const json = JSON.stringify(rows);
    for (const k of ["Asma", "Udang", "Ventolin", "Ibu 0899", "kesehatan"]) expect(json).not.toContain(k);
    expect(Object.keys(rows[0])).not.toContain("kesehatan");
    expect(JSON.stringify(rows)).not.toContain(P.riwayatPenyakit);
  });
  it("other paroki's admin sees neither the rows nor the health data", async () => {
    const rows = await listPesertaView(admLaur);
    expect(JSON.stringify(rows)).not.toContain("Asma");
    expect(rows.every((r) => r.eventId === "recEVLAUR18A00001" || r.eventId === "recEVLAUR18B00001")).toBe(true);
  });
  it("flags (does not drop) the same person with same WA and similar name in one event", async () => {
    const rows = await listPesertaView(sep);
    const inB = rows.filter((r) => r.eventId === "recEVLAUR18B00001" && r.kategori === "Peserta");
    expect(inB.filter((r) => r.statusPendaftaran !== "Batal")).toHaveLength(3);
    const budi = inB.filter((r) => r.namaLengkap.startsWith("Budi"));
    expect(budi).toHaveLength(2);
    expect(budi.every((r) => r.kemungkinanGanda)).toBe(true);
    expect(inB.filter((r) => !r.namaLengkap.startsWith("Budi")).every((r) => !r.kemungkinanGanda)).toBe(true);
  });
  it("limits to an eventKep when given", async () => {
    const rows = await listPesertaView(sep, "recKEPPANDU900001");
    expect(rows.map((r) => r.eventId)).toEqual(["recEVPANDU900001"]);
  });
});

// ------------------------------------------------------------------ fix round 1
const mk = (id: string, fields: Record<string, unknown>) => ({ id, fields });
const E = F.events, K = F.eventKep, P = F.pendaftaranEvents, U = F.teamUmat;
function addCourse(opts: { ev: string; name: string; kep?: { id: string; orgs: string[]; status?: string }[] }) {
  store[T.events].push(mk(opts.ev, { [E.namaAcara]: opts.name, [E.kelompokAcara]: "KEP", [EVENT_ID_FIELD]: `2601-${opts.name}` }));
  for (const k of opts.kep ?? [])
    store[T.eventKep].push(mk(k.id, { [K.events]: [opts.ev], [K.penyelenggara]: k.orgs, ...(k.status ? { [K.statusPersetujuan]: k.status } : {}) }));
}
const person = (id: string, nama: string, wa?: string, email?: string) =>
  store[T.teamUmat].push(mk(id, { [U.namaLengkap]: nama, ...(wa ? { [U.noWhatsapp]: wa } : {}), ...(email ? { [U.email]: email } : {}) }));
const daftar = (id: string, ev: string, tu: string, extra: Record<string, unknown> = {}) =>
  store[T.pendaftaranEvents].push(mk(id, { [P.event]: [ev], [P.teamUmat]: [tu], [P.statusPendaftaran]: "Daftar", [P.kategoriKepesertaan]: "Peserta", ...extra }));
const ORG_L = "recORGLAUR0000001", ORG_P = "recORGPANDU000001";

describe("fix round 1: scope is ALL linked KEPs, fail closed", () => {
  for (const reversed of [false, true]) {
    it(`multi-KEP event across two parishes is hidden from both PICs (${reversed ? "reversed" : "natural"} row order)`, async () => {
      addCourse({ ev: "recEVMULTI0000001", name: "KEP PAROKI MULTI ANGKATAN 2", kep: [{ id: "recKEPMULTI000001", orgs: [ORG_L], status: "Disetujui" }, { id: "recKEPMULTI000002", orgs: [ORG_P], status: "Disetujui" }] });
      person("recTUM1000000000001", "Multi Orang", "087000000001");
      daftar("recPSM1000000000001", "recEVMULTI0000001", "recTUM1000000000001", { [P.riwayatPenyakit]: "Rahasia" });
      if (reversed) { store[T.eventKep].reverse(); store[T.penyelenggaraKep].reverse(); store[T.events].reverse(); }
      for (const s of [picPandu, admLaur]) {
        expect((await listKepEvents({ parokiId: s.parokiId! })).some((e) => e.eventId === "recEVMULTI0000001")).toBe(false);
        expect(JSON.stringify(await listPesertaView(s))).not.toContain("Rahasia");
        expect(await listPesertaView(s, s === picPandu ? "recKEPMULTI000002" : "recKEPMULTI000001")).toEqual([]);
      }
      const sepRows = await listKepEvents({ parokiId: "ALL" });
      const m = sepRows.find((e) => e.eventId === "recEVMULTI0000001")!;
      expect(m).toMatchObject({ parokiId: null, parokiNama: "Belum terpetakan" });
      const view = await listPesertaView(sep, "recKEPMULTI000002"); // any linked KEP id works
      expect(view).toHaveLength(1);
      expect(JSON.stringify(view)).not.toContain("Rahasia");
    });
  }
  it("a linked KEP without organizer blocks PIC visibility", async () => {
    addCourse({ ev: "recEVNOORG00000001", name: "KEP PAROKI NOORG ANGKATAN 1", kep: [{ id: "recKEPNOORG000001", orgs: [ORG_P], status: "Disetujui" }, { id: "recKEPNOORG000002", orgs: [], status: "Disetujui" }] });
    expect((await listKepEvents({ parokiId: PANDU })).some((e) => e.eventId === "recEVNOORG00000001")).toBe(false);
  });
});

describe("fix round 1: dedupe is pairwise, name-aware, no chaining", () => {
  beforeEach(() => addCourse({ ev: "recEVDEDUP0000001", name: "KEP PAROKI PANDU ANGKATAN 10", kep: [{ id: "recKEPDEDUP000001", orgs: [ORG_P], status: "Disetujui" }] }));
  const count = async () => (await listKepEvents({ parokiId: PANDU })).find((e) => e.eventId === "recEVDEDUP0000001")!.pesertaCount;

  it("couple sharing one phone stays two people, not flagged", async () => {
    person("recTUH1000000000001", "Budi Hartono", "0811-000-1111");
    person("recTUH2000000000001", "Siti Hartono", "+62 811 0001 111");
    daftar("recPSH1000000000001", "recEVDEDUP0000001", "recTUH1000000000001");
    daftar("recPSH2000000000001", "recEVDEDUP0000001", "recTUH2000000000001");
    expect(await count()).toBe(2);
    const rows = (await listPesertaView(picPandu)).filter((r) => r.eventId === "recEVDEDUP0000001");
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.kemungkinanGanda)).toBe(false);
  });
  it("placeholder phone shared by more than 3 names is ignored", async () => {
    const names = ["Andi Wijaya", "Andi W.", "Rina Putri", "Doni Kusuma", "Eko Prasetyo"];
    names.forEach((n, i) => { person(`recTUP${i}000000000001`, n, "0800-0000-0000"); daftar(`recPSP${i}000000000001`, "recEVDEDUP0000001", `recTUP${i}000000000001`, { [P.keterangan]: "LULUS" }); });
    expect(await count()).toBe(5);
    const rows = (await listPesertaView(picPandu)).filter((r) => r.eventId === "recEVDEDUP0000001");
    expect(rows.some((r) => r.kemungkinanGanda)).toBe(false);
  });
  it("A~B by phone and B~C by email with different names does not chain", async () => {
    person("recTUC1000000000001", "Joko Widodo", "0822-1111-2222");
    person("recTUC2000000000001", "Joko W.", "0822-1111-2222", "x@mail.com");
    person("recTUC3000000000001", "Mega Putri", undefined, "X@mail.com");
    ["1", "2", "3"].forEach((n) => daftar(`recPSC${n}000000000001`, "recEVDEDUP0000001", `recTUC${n}000000000001`));
    expect(await count()).toBe(2);
  });
  it("lulusan is not undercut by a placeholder number, and ignores Batal / Dobel Daftar", async () => {
    const before = (await publicStats()).lulusan;
    ["Aa Bb", "Cc Dd", "Ee Ff", "Gg Hh"].forEach((n, i) => { person(`recTUL${i}000000000001`, n, "0899-9999-9999"); daftar(`recPSL${i}000000000001`, "recEVDEDUP0000001", `recTUL${i}000000000001`, { [P.keterangan]: "LULUS" }); });
    person("recTUL9000000000001", "Zz Yy", "0877-0000-0001");
    daftar("recPSL9000000000001", "recEVDEDUP0000001", "recTUL9000000000001", { [P.keterangan]: "LULUS", [P.statusPendaftaran]: "Batal" });
    daftar("recPSL9000000000002", "recEVDEDUP0000001", "recTUL9000000000001", { [P.keterangan]: "LULUS", [P.statusPendaftaran]: "Dobel Daftar" });
    invalidateKepCache();
    expect((await publicStats()).lulusan).toBe(before + 4);
  });
});

describe("fix round 1: public visibility and small cells", () => {
  it("a linked EventKEP without status is Diajukan and not public", async () => {
    addCourse({ ev: "recEVNOSTAT0000001", name: "KEP PAROKI PANDU ANGKATAN 11", kep: [{ id: "recKEPNOSTAT000001", orgs: [ORG_P] }] });
    expect((await listKepEvents({ parokiId: "ALL" })).find((e) => e.eventId === "recEVNOSTAT0000001")!.status).toBe("Diajukan");
    expect((await publicStats()).angkatan).toBe(3);
  });
  it("suppresses per-parish values below 3 but keeps totals honest", async () => {
    addCourse({ ev: "recEVSMALL00000001", name: "KEP PAROKI ZZ ANGKATAN 2", kep: [{ id: "recKEPSMALL000001", orgs: ["recORGZZ00000001"], status: "Disetujui" }] });
    const s = await publicStats();
    expect(s.daftarParoki).toContainEqual({ nama: "Paroki ZZ", angkatan: "<3" });
    expect(s.paroki).toBe(3);
    expect(s.angkatan).toBe(4);
  });
});

describe("fix round 1: cold-read load", () => {
  it("filters Events by Kelompok Acara and Pendaftaran Events by KEP event ids", async () => {
    await publicStats();
    const calls = vi.mocked(listRecords).mock.calls;
    const ev = calls.find((c) => c[0] === T.events)![1];
    expect(ev.filterByFormula).toContain(`{${E.kelompokAcara}}`);
    expect(ev.filterByFormula).toContain("'KEP'");
    const pend = calls.filter((c) => c[0] === T.pendaftaranEvents).map((c) => c[1].filterByFormula ?? "");
    expect(pend.length).toBeGreaterThan(0);
    for (const f of pend) { expect(f).toContain(`{${P.event}}`); expect(f).toContain("2601-KEP PAROKI"); }
  });
  it("escapes quotes and backslashes in EventID values inside formulas", async () => {
    const raw = String.raw`x"y\z`;
    store[T.events].push(mk("recEVQUOTE00000001", { [E.namaAcara]: "KEP PAROKI QUOTE ANGKATAN 1", [E.kelompokAcara]: "KEP", [EVENT_ID_FIELD]: raw }));
    await listKepEvents({ parokiId: "ALL" });
    const f = vi.mocked(listRecords).mock.calls.filter((c) => c[0] === T.pendaftaranEvents).map((c) => c[1].filterByFormula).join("|");
    expect(f).toContain(String.raw`x\"y\\z`);
  });
  it("concurrent callers share one load (single flight)", async () => {
    await Promise.all(Array.from({ length: 6 }, () => listKepEvents({ parokiId: "ALL" })));
    for (const t of [T.events, T.eventKep, T.teamUmat, T.paroki, T.penyelenggaraKep]) expect(vi.mocked(listRecords).mock.calls.filter((c) => c[0] === t)).toHaveLength(1);
  });
  it("backs off after a failed cold load instead of re-reading Airtable on every call", async () => {
    vi.mocked(listRecords).mockRejectedValue(new Error("down"));
    try {
      await expect(listKepEvents({ parokiId: "ALL" })).rejects.toThrow();
      const n = vi.mocked(listRecords).mock.calls.length;
      await expect(listKepEvents({ parokiId: "ALL" })).rejects.toThrow();
      expect(vi.mocked(listRecords).mock.calls.length).toBe(n);
    } finally { vi.mocked(listRecords).mockImplementation(fakeClientModule().listRecords); }
  });
  it("serves the last good table values when a refresh fails", async () => {
    vi.useFakeTimers();
    try {
      const first = await listKepEvents({ parokiId: "ALL" });
      vi.advanceTimersByTime(61_000);
      vi.mocked(listRecords).mockRejectedValue(new Error("down"));
      expect(await listKepEvents({ parokiId: "ALL" })).toEqual(first);
    } finally { vi.useRealTimers(); vi.mocked(listRecords).mockImplementation(fakeClientModule().listRecords); }
  });
  it("an invalidation cannot be overwritten by an older in-flight load", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = fakeClientModule().listRecords;
    vi.mocked(listRecords).mockImplementation(async (t, o) => { const out = await real(t, o); if (t === T.events) await gate; return out; });
    try {
      const p1 = listKepEvents({ parokiId: "ALL" });
      await new Promise((r) => setTimeout(r, 5));
      store[T.events].push(mk("recEVLATE000000001", { [E.namaAcara]: "KEP PAROKI LATE ANGKATAN 1", [E.kelompokAcara]: "KEP", [EVENT_ID_FIELD]: "2601-LATE" }));
      invalidateKepCache();
      release();
      await p1;
      const again = await listKepEvents({ parokiId: "ALL" });
      expect(again.some((e) => e.eventId === "recEVLATE000000001")).toBe(true);
    } finally { vi.mocked(listRecords).mockImplementation(real); }
  });
  it("never requests health fields for SEP", async () => {
    await listPesertaView(sep);
    const asked = vi.mocked(listRecords).mock.calls.flatMap((c) => c[1].fields);
    for (const f of [F.pendaftaranEvents.riwayatPenyakit, F.pendaftaranEvents.riwayatAlergi, F.pendaftaranEvents.obatRutin, F.pendaftaranEvents.kontakDarurat]) expect(asked).not.toContain(f);
  });
  it("public TTL boundary: cached at 9 minutes, refreshed at 11", async () => {
    vi.useFakeTimers();
    try {
      await publicStats();
      vi.advanceTimersByTime(9 * 60_000);
      const n = vi.mocked(listRecords).mock.calls.length;
      await publicStats();
      expect(vi.mocked(listRecords).mock.calls.length).toBe(n);
      vi.advanceTimersByTime(2 * 60_000);
      await publicStats();
      expect(vi.mocked(listRecords).mock.calls.length).toBeGreaterThan(n);
    } finally { vi.useRealTimers(); }
  });
});
