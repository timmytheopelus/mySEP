import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, store } from "../helpers/fake-airtable";
import { resetReadCache } from "@/lib/airtable/cacheStore";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn() }));

import * as client from "@/lib/airtable/client";
import { batalkanMundur, getAbsenSheet, getPenetapanSheet, mundurkanPeserta, setHadir, setSemuaHadir, tetapkanHasil } from "@/lib/kep/absensi";
import type { Session } from "@/lib/auth/session";
import { HttpError } from "@/lib/http/errors";

const P = F.pendaftaranEvents;
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const adm: Session = { accountId: "recADM0000000001", email: "adm@x.id", role: "ADMIN", parokiId: PA };
const admB: Session = { accountId: "recADMB000000001", email: "admb@x.id", role: "ADMIN", parokiId: PB };
const sep: Session = { accountId: "recSEPA000000001", email: "sep@x.id", role: "SEP", parokiId: null };

const KEP_A = "recKEPA0000000001";
const KEP_B = "recKEPB0000000001";
const EV_A = "recEVA00000000001";
const EV_B = "recEVB00000000001";
const S1 = "recSUB1000000001";
const S2 = "recSUB2000000001";
const S3 = "recSUB3000000001";
const SB = "recSUBB000000001";
const pid = (n: number) => `recPEND${String(n).padStart(10, "0")}`;
const tid = (n: number) => `recTEAM${String(n).padStart(10, "0")}`;
const op = (n: string) => `op-${n}-0000000`;

const hadirOf = (id: string) => ((store[T.pendaftaranEvents].find((r) => r.id === id)?.fields[P.pertemuanHadir] as string[]) ?? []);
const rowOf = (id: string) => store[T.pendaftaranEvents].find((r) => r.id === id)!;
const audits = (aksi?: string) => (store[T.auditKep] ?? []).filter((r) => !aksi || r.fields[F.auditKep.aksi] === aksi);
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof HttpError ? e.status : 500;
  }
};

function seed(names = ["Yohanes", "bernadus", "Agnes", "Celine"], extra: Record<number, Record<string, unknown>> = {}) {
  store[T.paroki] = [{ id: PA, fields: {} }, { id: PB, fields: {} }];
  store[T.penyelenggaraKep] = [
    { id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: "recORGB0000000001", fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  store[T.eventKep] = [
    { id: KEP_A, fields: { [F.eventKep.events]: [EV_A], [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.statusPersetujuan]: "Disetujui" } },
    { id: KEP_B, fields: { [F.eventKep.events]: [EV_B], [F.eventKep.penyelenggara]: ["recORGB0000000001"], [F.eventKep.statusPersetujuan]: "Disetujui" } },
  ];
  store[T.subEvent] = [
    { id: S1, fields: { [F.subEvent.acara]: [EV_A], [F.subEvent.agenda]: "Bab 1", [F.subEvent.urutan]: 1, [F.subEvent.tanggal]: "2026-03-01" } },
    { id: S2, fields: { [F.subEvent.acara]: [EV_A], [F.subEvent.agenda]: "Bab 2", [F.subEvent.urutan]: 2, [F.subEvent.tanggal]: "2026-03-08" } },
    { id: S3, fields: { [F.subEvent.acara]: [EV_A], [F.subEvent.agenda]: "Bab 3", [F.subEvent.urutan]: 3, [F.subEvent.tanggal]: "2026-03-15" } },
    { id: SB, fields: { [F.subEvent.acara]: [EV_B], [F.subEvent.agenda]: "Bab 1", [F.subEvent.urutan]: 1, [F.subEvent.tanggal]: "2026-03-01" } },
  ];
  store[T.teamUmat] = [...names.map((n, i) => ({ id: tid(i + 1), fields: { [F.teamUmat.namaLengkap]: n } })), { id: tid(99), fields: { [F.teamUmat.namaLengkap]: "Orang B" } }];
  store[T.pendaftaranEvents] = [
    ...names.map((_, i) => ({
      id: pid(i + 1),
      fields: { [P.event]: [EV_A], [P.teamUmat]: [tid(i + 1)], [P.statusPendaftaran]: "Confirmed", [P.kategoriKepesertaan]: "Peserta", ...(extra[i + 1] ?? {}) },
    })),
    { id: pid(99), fields: { [P.event]: [EV_B], [P.teamUmat]: [tid(99)], [P.statusPendaftaran]: "Confirmed", [P.kategoriKepesertaan]: "Peserta" } },
  ];
  store[T.auditKep] = [];
}

beforeEach(() => {
  vi.stubEnv("ABSEN_RECHECK_MS", "0");
  resetStore();
  seed();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("getAbsenSheet", () => {
  it("sorts alphabetically (case-insensitive), flags mundur and excludes them from aktifCount", async () => {
    seed(["Yohanes", "bernadus", "Agnes", "Celine"], { 4: { [P.keterangan]: "MENGUNDURKAN DIRI" } });
    store[T.pendaftaranEvents][0].fields[P.pertemuanHadir] = [S1]; // Yohanes hadir
    store[T.pendaftaranEvents][3].fields[P.pertemuanHadir] = [S1]; // Celine (mundur) hadir earlier
    const s = await getAbsenSheet(pic, KEP_A, S1);
    expect(s.subEvent).toEqual({ id: S1, agenda: "Bab 1", tanggal: "2026-03-01" });
    expect(s.peserta.map((p) => p.nama)).toEqual(["Agnes", "bernadus", "Celine", "Yohanes"]);
    expect(s.peserta.find((p) => p.nama === "Celine")).toMatchObject({ mundur: true, hadir: true });
    expect(s.aktifCount).toBe(3);
    expect(s.hadirCount).toBe(1);
    expect(JSON.stringify(s)).not.toContain("Orang B");
  });
  it("excludes panitia and inactive registrations", async () => {
    seed(["A", "B", "C"], { 2: { [P.kategoriKepesertaan]: "Panitia" }, 3: { [P.statusPendaftaran]: "Batal" } });
    expect((await getAbsenSheet(pic, KEP_A, S1)).peserta.map((p) => p.nama)).toEqual(["A"]);
  });
  it("404 for another parish, 403 for SEP, 404 for a subEvent of another KEP", async () => {
    expect(await status(getAbsenSheet(admB, KEP_A, S1))).toBe(404);
    expect(await status(getAbsenSheet(sep, KEP_A, S1))).toBe(403);
    expect(await status(getAbsenSheet(pic, KEP_A, SB))).toBe(404);
    expect(await status(getAbsenSheet(pic, KEP_A, "recBOGUS"))).toBe(404);
  });
  it("409 when the KEP is not Disetujui", async () => {
    store[T.eventKep][0].fields[F.eventKep.statusPersetujuan] = "Diajukan";
    expect(await status(getAbsenSheet(pic, KEP_A, S1))).toBe(409);
  });
});

describe("setHadir", () => {
  it("same opId twice: exactly one link and one audit", async () => {
    expect(await setHadir(pic, KEP_A, S1, pid(1), true, op("a"))).toEqual({ hadir: true });
    await setHadir(pic, KEP_A, S1, pid(1), true, op("a"));
    expect(hadirOf(pid(1))).toEqual([S1]);
    expect(audits("absen_set")).toHaveLength(1);
    expect(vi.mocked(client.updateRecords)).toHaveBeenCalledTimes(1);
  });
  it("different opId, same value: still one link, no extra audit or write", async () => {
    await setHadir(adm, KEP_A, S1, pid(1), true, op("a"));
    await setHadir(adm, KEP_A, S1, pid(1), true, op("b"));
    expect(hadirOf(pid(1))).toEqual([S1]);
    expect(audits("absen_set")).toHaveLength(1);
    expect(vi.mocked(client.updateRecords)).toHaveBeenCalledTimes(1);
  });
  it("hadir=false removes only that SubEvent", async () => {
    await setHadir(pic, KEP_A, S1, pid(1), true, op("a"));
    await setHadir(pic, KEP_A, S2, pid(1), true, op("b"));
    await setHadir(pic, KEP_A, S1, pid(1), false, op("c"));
    expect(hadirOf(pid(1))).toEqual([S2]);
    expect(await setHadir(pic, KEP_A, S1, pid(1), false, op("d"))).toEqual({ hadir: false });
    expect(audits("absen_set")).toHaveLength(3);
  });
  it("audit rows hold ids and flags only (no names, no health data)", async () => {
    store[T.pendaftaranEvents][0].fields[P.riwayatPenyakit] = "diabetes";
    await setHadir(pic, KEP_A, S1, pid(1), true, op("a"));
    const raw = JSON.stringify(audits());
    expect(raw).not.toContain("diabetes");
    expect(raw).not.toContain("Yohanes");
  });
  it("mundur peserta is rejected, also after being marked mundur", async () => {
    await mundurkanPeserta(pic, KEP_A, pid(1), op("m"));
    expect(await status(setHadir(pic, KEP_A, S1, pid(1), true, op("a")))).toBe(409);
    expect(await status(setHadir(pic, KEP_A, S1, pid(1), false, op("b")))).toBe(409);
    expect(hadirOf(pid(1))).toEqual([]);
  });
  it("cross-parish ADMIN => 404; SEP => 403; malformed ids => 404; bad opId => 422", async () => {
    expect(await status(setHadir(admB, KEP_A, S1, pid(1), true, op("a")))).toBe(404);
    expect(await status(setHadir(sep, KEP_A, S1, pid(1), true, op("a")))).toBe(403);
    expect(await status(setHadir(pic, KEP_A, S1, "nope", true, op("a")))).toBe(404);
    expect(await status(setHadir(pic, KEP_A, S1, pid(1), true, "short"))).toBe(422);
    expect(await status(setHadir(pic, KEP_A, S1, pid(1), "yes" as unknown as boolean, op("a")))).toBe(422);
    expect(audits()).toHaveLength(0);
  });
  it("subEvent from another KEP => 404, peserta from another KEP => 404, nothing written", async () => {
    expect(await status(setHadir(pic, KEP_A, SB, pid(1), true, op("a")))).toBe(404);
    expect(await status(setHadir(pic, KEP_A, S1, pid(99), true, op("b")))).toBe(404);
    expect(hadirOf(pid(99))).toEqual([]);
    expect(audits()).toHaveLength(0);
    expect(vi.mocked(client.updateRecords)).not.toHaveBeenCalled();
  });
  it("409 when the KEP is not Disetujui", async () => {
    store[T.eventKep][0].fields[F.eventKep.statusPersetujuan] = "Ditolak";
    expect(await status(setHadir(pic, KEP_A, S1, pid(1), true, op("a")))).toBe(409);
  });
  it("concurrent calls on the same peserta (different subEvents) keep both links", async () => {
    await Promise.all([
      setHadir(pic, KEP_A, S1, pid(1), true, op("a")),
      setHadir(pic, KEP_A, S2, pid(1), true, op("b")),
      setHadir(pic, KEP_A, S3, pid(1), true, op("c")),
    ]);
    expect([...hadirOf(pid(1))].sort()).toEqual([S1, S2, S3]);
  });
  it("concurrent same opId does not double write or audit", async () => {
    await Promise.all([setHadir(pic, KEP_A, S1, pid(1), true, op("a")), setHadir(pic, KEP_A, S1, pid(1), true, op("a"))]);
    expect(hadirOf(pid(1))).toEqual([S1]);
    expect(audits("absen_set")).toHaveLength(1);
  });
  it("post-write verify: a lost write is retried once", async () => {
    vi.mocked(client.updateRecords).mockImplementationOnce(async () => []); // first write silently lost
    await setHadir(pic, KEP_A, S1, pid(1), true, op("a"));
    expect(hadirOf(pid(1))).toEqual([S1]);
    expect(vi.mocked(client.updateRecords)).toHaveBeenCalledTimes(2);
  });
  it("post-write verify: gives up with 503 after one retry", async () => {
    vi.mocked(client.updateRecords).mockImplementationOnce(async () => []).mockImplementationOnce(async () => []);
    expect(await status(setHadir(pic, KEP_A, S1, pid(1), true, op("a")))).toBe(503);
    expect(vi.mocked(client.updateRecords)).toHaveBeenCalledTimes(2);
  });
  it("a failed write does not poison the opId: the retry with the same opId writes", async () => {
    vi.mocked(client.updateRecords).mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    expect(await status(setHadir(pic, KEP_A, S1, pid(1), true, op("a")))).toBe(500);
    await setHadir(pic, KEP_A, S1, pid(1), true, op("a"));
    expect(hadirOf(pid(1))).toEqual([S1]);
  });
});

describe("setSemuaHadir", () => {
  it("marks every active peserta, skips mundur, returns the count; replay is a no-op", async () => {
    seed(["A", "B", "C", "D"], { 3: { [P.keterangan]: "MENGUNDURKAN DIRI" } });
    store[T.pendaftaranEvents][0].fields[P.pertemuanHadir] = [S2];
    expect(await setSemuaHadir(pic, KEP_A, S1, op("s"))).toEqual({ updated: 3, remaining: 0 });
    expect(hadirOf(pid(1))).toEqual([S2, S1]);
    expect(hadirOf(pid(3))).toEqual([]);
    expect(hadirOf(pid(99))).toEqual([]);
    const writes = vi.mocked(client.updateRecords).mock.calls.length;
    expect(await setSemuaHadir(pic, KEP_A, S1, op("s"))).toEqual({ updated: 3, remaining: 0 });
    expect(vi.mocked(client.updateRecords).mock.calls.length).toBe(writes);
  });
  it("already-present peserta are not counted", async () => {
    await setHadir(pic, KEP_A, S1, pid(1), true, op("a"));
    expect(await setSemuaHadir(pic, KEP_A, S1, op("s"))).toEqual({ updated: 3, remaining: 0 });
  });
  it("SEP 403, other parish 404, foreign subEvent 404", async () => {
    expect(await status(setSemuaHadir(sep, KEP_A, S1, op("s")))).toBe(403);
    expect(await status(setSemuaHadir(admB, KEP_A, S1, op("s")))).toBe(404);
    expect(await status(setSemuaHadir(pic, KEP_A, SB, op("s")))).toBe(404);
  });
});

describe("mundurkanPeserta", () => {
  it("sets Keterangan, audits once, replay and repeat are no-ops", async () => {
    await mundurkanPeserta(adm, KEP_A, pid(2), op("m"));
    expect(rowOf(pid(2)).fields[P.keterangan]).toBe("MENGUNDURKAN DIRI");
    await mundurkanPeserta(adm, KEP_A, pid(2), op("m"));
    await mundurkanPeserta(adm, KEP_A, pid(2), op("n"));
    expect(audits("peserta_mundur")).toHaveLength(1);
  });
  it("keeps earlier attendance", async () => {
    await setHadir(pic, KEP_A, S1, pid(2), true, op("a"));
    await mundurkanPeserta(pic, KEP_A, pid(2), op("m"));
    expect(hadirOf(pid(2))).toEqual([S1]);
  });
  it("SEP 403, other parish 404, peserta of another KEP 404", async () => {
    expect(await status(mundurkanPeserta(sep, KEP_A, pid(2), op("m")))).toBe(403);
    expect(await status(mundurkanPeserta(admB, KEP_A, pid(2), op("m")))).toBe(404);
    expect(await status(mundurkanPeserta(pic, KEP_A, pid(99), op("m")))).toBe(404);
    expect(rowOf(pid(99)).fields[P.keterangan]).toBeUndefined();
  });
});

describe("tetapkanHasil", () => {
  const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
  it("rejected before the last pertemuan date (WIB), allowed from that date on", async () => {
    at("2026-03-14T16:59:59Z"); // 23:59:59 WIB on the 14th
    expect(await status(tetapkanHasil(pic, KEP_A, pid(1), "LULUS", op("h")))).toBe(409);
    expect(rowOf(pid(1)).fields[P.keterangan]).toBeUndefined();
    at("2026-03-14T17:00:00Z"); // 00:00 WIB on the 15th
    await tetapkanHasil(pic, KEP_A, pid(1), "LULUS", op("h"));
    expect(rowOf(pid(1)).fields[P.keterangan]).toBe("LULUS");
    expect(audits("hasil_tetap")).toHaveLength(1);
  });
  it("TIDAK LULUS, change of result, replay and same value", async () => {
    at("2026-04-01T00:00:00Z");
    await tetapkanHasil(adm, KEP_A, pid(1), "TIDAK LULUS", op("h"));
    expect(rowOf(pid(1)).fields[P.keterangan]).toBe("TIDAK LULUS");
    await tetapkanHasil(adm, KEP_A, pid(1), "TIDAK LULUS", op("h"));
    await tetapkanHasil(adm, KEP_A, pid(1), "TIDAK LULUS", op("i"));
    expect(audits("hasil_tetap")).toHaveLength(1);
    await tetapkanHasil(adm, KEP_A, pid(1), "LULUS", op("j"));
    expect(rowOf(pid(1)).fields[P.keterangan]).toBe("LULUS");
    expect(audits("hasil_tetap")).toHaveLength(2);
  });
  it("mundur peserta cannot be given a result", async () => {
    at("2026-04-01T00:00:00Z");
    await mundurkanPeserta(pic, KEP_A, pid(1), op("m"));
    expect(await status(tetapkanHasil(pic, KEP_A, pid(1), "LULUS", op("h")))).toBe(409);
    expect(rowOf(pid(1)).fields[P.keterangan]).toBe("MENGUNDURKAN DIRI");
  });
  it("validation, scope and roles", async () => {
    at("2026-04-01T00:00:00Z");
    expect(await status(tetapkanHasil(pic, KEP_A, pid(1), "MUNDUR" as never, op("h")))).toBe(422);
    expect(await status(tetapkanHasil(sep, KEP_A, pid(1), "LULUS", op("h")))).toBe(403);
    expect(await status(tetapkanHasil(admB, KEP_A, pid(1), "LULUS", op("h")))).toBe(404);
    expect(await status(tetapkanHasil(pic, KEP_A, pid(99), "LULUS", op("h")))).toBe(404);
    store[T.eventKep][0].fields[F.eventKep.statusPersetujuan] = "Diajukan";
    resetReadCache(); // a direct Airtable edit is seen once the 45 s scope cache expires
    expect(await status(tetapkanHasil(pic, KEP_A, pid(1), "LULUS", op("h")))).toBe(409);
  });
});

describe("round 1 fixes", () => {
  it("I-1: an opId is bound to its payload (409 on a different subEvent / value / hasil)", async () => {
    await setHadir(pic, KEP_A, S1, pid(1), true, op("a"));
    expect(await status(setHadir(pic, KEP_A, S2, pid(1), true, op("a")))).toBe(409);
    expect(await status(setHadir(pic, KEP_A, S1, pid(1), false, op("a")))).toBe(409);
    expect(hadirOf(pid(1))).toEqual([S1]);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-04-01T00:00:00Z") });
    await tetapkanHasil(pic, KEP_A, pid(2), "LULUS", op("h"));
    expect(await status(tetapkanHasil(pic, KEP_A, pid(2), "TIDAK LULUS", op("h")))).toBe(409);
    expect(rowOf(pid(2)).fields[P.keterangan]).toBe("LULUS");
  });
  it("I-1/I-2: a replay superseded by a newer opId returns the real state and writes nothing", async () => {
    await setHadir(pic, KEP_A, S1, pid(1), true, op("a"));
    await setHadir(pic, KEP_A, S1, pid(1), false, op("b"));
    const writes = vi.mocked(client.updateRecords).mock.calls.length;
    expect(await setHadir(pic, KEP_A, S1, pid(1), true, op("a"))).toEqual({ hadir: false });
    expect(vi.mocked(client.updateRecords).mock.calls.length).toBe(writes);
    expect(hadirOf(pid(1))).toEqual([]);
  });
  it("I-2: write failure + failed _gagal audit, then replay re-applies (absen_set_ulang)", async () => {
    const orig = vi.mocked(client.createRecords).getMockImplementation()!;
    vi.mocked(client.createRecords)
      .mockImplementationOnce(orig)
      .mockImplementationOnce(async () => {
        throw new Error("audit down");
      });
    vi.mocked(client.updateRecords).mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    // order: audit ok -> write throws -> _gagal audit throws
    expect(await status(setHadir(pic, KEP_A, S1, pid(1), true, op("a")))).toBe(500);
    expect(hadirOf(pid(1))).toEqual([]);
    expect(await setHadir(pic, KEP_A, S1, pid(1), true, op("a"))).toEqual({ hadir: true });
    expect(hadirOf(pid(1))).toEqual([S1]);
    expect(audits("absen_set_ulang")).toHaveLength(1);
  });
  it("I-3: with ABSEN_RECHECK_MS > 0, a delayed verify read re-applies a link lost to another instance", async () => {
    vi.stubEnv("ABSEN_RECHECK_MS", "1");
    const orig = vi.mocked(client.getRecord).getMockImplementation()!;
    vi.mocked(client.getRecord)
      .mockImplementationOnce(orig) // fresh read (the PATCH response is the first verify)
      .mockImplementationOnce(async (t: string, id: string) => {
        const r = await orig(t, id);
        r.fields[P.pertemuanHadir] = [];
        return r;
      }); // delayed verify sees the link gone
    await setHadir(pic, KEP_A, S1, pid(1), true, op("a"));
    expect(vi.mocked(client.updateRecords)).toHaveBeenCalledTimes(2);
    expect(hadirOf(pid(1))).toEqual([S1]);
  });
  it("I-4: semua is capped at 60 per call and resumes with the same opId", async () => {
    seed(Array.from({ length: 70 }, (_, i) => `N${String(i).padStart(3, "0")}`));
    expect(await setSemuaHadir(pic, KEP_A, S1, op("s"))).toEqual({ updated: 60, remaining: 10 });
    expect(await setSemuaHadir(pic, KEP_A, S1, op("s"))).toEqual({ updated: 70, remaining: 0 });
    expect((await getAbsenSheet(pic, KEP_A, S1)).hadirCount).toBe(70);
    expect(await setSemuaHadir(pic, KEP_A, S1, op("s"))).toEqual({ updated: 70, remaining: 0 });
  });
  it("I-4: a time budget stops the run after at least one batch of 10", async () => {
    seed(Array.from({ length: 25 }, (_, i) => `N${String(i).padStart(3, "0")}`));
    vi.stubEnv("ABSEN_SEMUA_BUDGET_MS", "0");
    const r = await setSemuaHadir(pic, KEP_A, S1, op("s"));
    expect(r).toEqual({ updated: 10, remaining: 15 });
    expect(await setSemuaHadir(pic, KEP_A, S1, op("s"))).toEqual({ updated: 20, remaining: 5 });
  });
  it("I-4: the end-of-run re-list re-applies a link that was lost", async () => {
    const orig = vi.mocked(client.updateRecords).getMockImplementation()!;
    let n = 0;
    vi.mocked(client.updateRecords).mockImplementation(async (t: string, rows: { id: string; fields: Record<string, unknown> }[], e?: Set<string>) => {
      // first batch PATCH: the second peserta's link silently does not stick (absent from the response)
      if (t === T.pendaftaranEvents && ++n === 1) return orig(t, rows.filter((_, i) => i !== 1), e);
      return orig(t, rows, e);
    });
    expect(await setSemuaHadir(pic, KEP_A, S1, op("s"))).toEqual({ updated: 4, remaining: 0 });
    expect(n).toBe(2); // one batch + one re-apply batch
    expect(audits("absen_set_ulang")).toHaveLength(1);
    for (const i of [1, 2, 3, 4]) expect(hadirOf(pid(i))).toEqual([S1]);
    vi.mocked(client.updateRecords).mockImplementation(orig);
  });
  it("I-5: names are fetched by RECORD_ID filter in chunks of at most 50", async () => {
    seed(Array.from({ length: 120 }, (_, i) => `N${String(i).padStart(3, "0")}`));
    await getAbsenSheet(pic, KEP_A, S1);
    const calls = vi.mocked(client.listRecords).mock.calls.filter((c) => c[0] === T.teamUmat);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      const f = String((c[1] as { filterByFormula?: string }).filterByFormula);
      expect(f).toContain("RECORD_ID()");
      expect((f.match(/RECORD_ID\(\)=/g) ?? []).length).toBeLessThanOrEqual(50);
    }
  });
  it("M-1: Keterangan is normalised (trim + case)", async () => {
    seed(["A", "B"], { 1: { [P.keterangan]: " mengundurkan diri " } });
    expect((await getAbsenSheet(pic, KEP_A, S1)).peserta.find((p) => p.nama === "A")?.mundur).toBe(true);
    expect(await status(setHadir(pic, KEP_A, S1, pid(1), true, op("a")))).toBe(409);
  });
  it("M-2: audit 'before' keeps only enum Keterangan values", async () => {
    seed(["A", "B"], { 1: { [P.keterangan]: "catatan rahasia" } });
    await mundurkanPeserta(pic, KEP_A, pid(1), op("m"));
    const raw = JSON.stringify(audits("peserta_mundur"));
    expect(raw).toContain("lainnya");
    expect(raw).not.toContain("rahasia");
  });
  it("M-4: the real opId is stored in the Op ID field", async () => {
    await setHadir(pic, KEP_A, S1, pid(1), true, op("a"));
    expect(audits("absen_set")[0].fields[F.auditKep.opId]).toBe(op("a"));
  });
  it("M-5: scope is checked before the hasil value", async () => {
    expect(await status(tetapkanHasil(admB, KEP_A, pid(1), "X" as never, op("h")))).toBe(404);
    expect(await status(tetapkanHasil(sep, KEP_A, pid(1), "X" as never, op("h")))).toBe(403);
  });
});

describe("batalkanMundur", () => {
  it("clears only MENGUNDURKAN DIRI, audits, then hadir works again; repeat is a no-op", async () => {
    await mundurkanPeserta(pic, KEP_A, pid(1), op("m"));
    await batalkanMundur(adm, KEP_A, pid(1), op("b"));
    expect(rowOf(pid(1)).fields[P.keterangan]).toBeUndefined();
    await batalkanMundur(adm, KEP_A, pid(1), op("c"));
    expect(audits("mundur_batal")).toHaveLength(1);
    expect(await setHadir(pic, KEP_A, S1, pid(1), true, op("a"))).toEqual({ hadir: true });
  });
  it("rejected when LULUS/TIDAK LULUS is set; SEP 403; other parish 404; other KEP 404", async () => {
    store[T.pendaftaranEvents][1].fields[P.keterangan] = "LULUS";
    expect(await status(batalkanMundur(pic, KEP_A, pid(2), op("b")))).toBe(409);
    expect(rowOf(pid(2)).fields[P.keterangan]).toBe("LULUS");
    expect(await status(batalkanMundur(sep, KEP_A, pid(1), op("b")))).toBe(403);
    expect(await status(batalkanMundur(admB, KEP_A, pid(1), op("b")))).toBe(404);
    expect(await status(batalkanMundur(pic, KEP_A, pid(99), op("b")))).toBe(404);
  });
});

describe("getPenetapanSheet persen", () => {
  afterEach(() => vi.useRealTimers());
  it("attendance % = hadir / pertemuan up to today (WIB), rounded; mundur excluded; no PII beyond nama", async () => {
    seed(["Agnes", "Bernadus", "Celine"], {
      1: { [P.pertemuanHadir]: [S1, S2, S3] }, // S3 is in the future: not counted
      2: { [P.pertemuanHadir]: [S1] },
      3: { [P.keterangan]: "MENGUNDURKAN DIRI", [P.pertemuanHadir]: [S1] },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-09T03:00:00Z"));
    const sh = await getPenetapanSheet(pic, KEP_A);
    expect(sh.peserta.map((p) => [p.nama, p.persen])).toEqual([["Agnes", 100], ["Bernadus", 50], ["Celine", null]]);
    expect(Object.keys(sh.peserta[0]).sort()).toEqual(["hasil", "id", "mundur", "nama", "persen"]);
  });
  it("persen is null when no pertemuan has happened yet", async () => {
    seed(["Agnes"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-01T03:00:00Z"));
    expect((await getPenetapanSheet(pic, KEP_A)).peserta[0].persen).toBeNull();
  });
});
