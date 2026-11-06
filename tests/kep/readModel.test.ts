import { beforeEach, describe, expect, it, vi } from "vitest";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, store } from "../helpers/fake-airtable";
import legacy from "./fixtures/legacy.json";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import { listRecords } from "@/lib/airtable/client";
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
    expect(all.find((e) => e.parokiId === PANDU)!.status).toBe("Lama");
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
  it("collapses the same person (same WA) in one event", async () => {
    const rows = await listPesertaView(sep);
    const inB = rows.filter((r) => r.eventId === "recEVLAUR18B00001" && r.kategori === "Peserta");
    expect(inB.filter((r) => r.statusPendaftaran !== "Batal")).toHaveLength(2);
    expect(inB.filter((r) => r.keterangan === "LULUS")).toHaveLength(1);
  });
  it("limits to an eventKep when given", async () => {
    const rows = await listPesertaView(sep, "recKEPPANDU900001");
    expect(rows.map((r) => r.eventId)).toEqual(["recEVPANDU900001"]);
  });
});
