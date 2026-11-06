import { beforeEach, describe, expect, it, vi } from "vitest";
import { F, RESTRICTED, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn() }));

import * as client from "@/lib/airtable/client";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { KepPartialError, createKep } from "@/lib/kep/create";
import { KEP_TEMPLATE } from "@/lib/kep/template";
import type { Session } from "@/lib/auth/session";

const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const picA: Session = { accountId: "recPICA000000001", email: "pica@x.id", role: "PIC", parokiId: PA };
const admA: Session = { accountId: "recADMA000000001", email: "adma@x.id", role: "ADMIN", parokiId: PA };
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const NOW = new Date("2026-11-06T03:00:00Z");
const input = { parokiId: PA, angkatan: 9, tanggalMulai: "2027-01-10" };
const rows = (t: string) => store[t] ?? [];

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  store[T.paroki] = [
    { id: PA, fields: { [F.paroki.nama]: "Pandu" } },
    { id: PB, fields: { [F.paroki.nama]: "Katedral" } },
  ];
});

describe("createKep authorization", () => {
  it("ADMIN and SEP get 403 and nothing is written", async () => {
    for (const s of [admA, sep]) await expect(createKep(s, input, { now: NOW })).rejects.toMatchObject({ status: 403 });
    expect(client.createRecords).not.toHaveBeenCalled();
  });
  it("PIC of paroki A creating for paroki B gets 404 and nothing is written", async () => {
    await expect(createKep(picA, { ...input, parokiId: PB }, { now: NOW })).rejects.toMatchObject({ status: 404 });
    expect(client.createRecords).not.toHaveBeenCalled();
  });
});

describe("createKep happy path", () => {
  it("creates organizer, Events, EventKEP, audit and 28 SubEvents", async () => {
    const r = await createKep(picA, input, { now: NOW });
    expect(r.subEventIds).toHaveLength(28);
    const org = rows(T.penyelenggaraKep);
    expect(org).toHaveLength(1);
    expect(org[0].fields[F.penyelenggaraKep.paroki]).toEqual([PA]);
    const ev = rows(T.events);
    expect(ev).toHaveLength(1);
    expect(ev[0].id).toBe(r.eventId);
    expect(ev[0].fields[F.events.namaAcara]).toBe("KEP PAROKI PANDU ANGKATAN 9");
    expect(ev[0].fields[F.events.kelompokAcara]).toBe("KEP");
    expect(ev[0].fields[F.events.tanggalAcara]).toBe("2027-01-10");
    const kep = rows(T.eventKep);
    expect(kep).toHaveLength(1);
    expect(kep[0].id).toBe(r.eventKepId);
    expect(kep[0].fields[F.eventKep.statusPersetujuan]).toBe("Diajukan");
    expect(kep[0].fields[F.eventKep.events]).toEqual([r.eventId]);
    expect(kep[0].fields[F.eventKep.penyelenggara]).toEqual([org[0].id]);
    const subs = rows(T.subEvent);
    expect(subs).toHaveLength(28);
    expect(subs.map((s) => s.fields[F.subEvent.agenda])).toEqual(KEP_TEMPLATE.map((e) => e.agenda));
    expect(subs.map((s) => s.fields[F.subEvent.urutan])).toEqual(KEP_TEMPLATE.map((e) => e.urutan));
    expect(subs.every((s) => (s.fields[F.subEvent.acara] as string[])[0] === r.eventId)).toBe(true);
    expect(subs[0].fields[F.subEvent.tanggal]).toBe("2027-01-10");
    expect(subs[1].fields[F.subEvent.tanggal]).toBe("2027-01-17");
    expect(invalidateKepCache).toHaveBeenCalled();
  });

  it("records the submitter in the AuditKEP create_kep row", async () => {
    const r = await createKep(picA, input, { now: NOW });
    const a = rows(T.auditKep).find((x) => x.fields[F.auditKep.aksi] === "create_kep")!;
    expect(a.fields[F.auditKep.pelaku]).toBe("pica@x.id");
    expect(a.fields[F.auditKep.targetId]).toBe(r.eventKepId);
  });

  it("reuses an existing Pengelenggara KEP row of the paroki", async () => {
    store[T.penyelenggaraKep] = [{ id: "recORG0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } }];
    const r = await createKep(picA, input, { now: NOW });
    expect(rows(T.penyelenggaraKep)).toHaveLength(1);
    expect(rows(T.eventKep).find((k) => k.id === r.eventKepId)!.fields[F.eventKep.penyelenggara]).toEqual(["recORG0000000001"]);
  });

  it("sets restricted fields only through the trusted extra set, never from input", async () => {
    await createKep(picA, { ...input, penyelenggara: ["recEVIL0000000001"], statusPersetujuan: "Disetujui" } as never, { now: NOW });
    const kepCall = vi.mocked(client.createRecords).mock.calls.find((c) => c[0] === T.eventKep)!;
    expect(kepCall[2]).toEqual(new Set([F.eventKep.statusPersetujuan, F.eventKep.penyelenggara]));
    expect(kepCall[1][0][F.eventKep.statusPersetujuan]).toBe("Diajukan");
    expect(rows(T.eventKep)[0].fields[F.eventKep.penyelenggara]).not.toContain("recEVIL0000000001");
    const orgCall = vi.mocked(client.createRecords).mock.calls.find((c) => c[0] === T.penyelenggaraKep)!;
    expect(orgCall[2]).toEqual(RESTRICTED[T.penyelenggaraKep]);
  });
});

describe("createKep validation (all before the first write)", () => {
  it.each([
    ["angkatan 0", { angkatan: 0 }],
    ["angkatan negative", { angkatan: -3 }],
    ["angkatan fraction", { angkatan: 1.5 }],
    ["angkatan string", { angkatan: "9" }],
    ["angkatan huge", { angkatan: 1e9 }],
    ["date garbage", { tanggalMulai: "besok" }],
    ["date impossible", { tanggalMulai: "2027-02-30" }],
    ["date with time", { tanggalMulai: "2027-01-10T00:00:00Z" }],
    ["date in the past", { tanggalMulai: "2026-11-01" }],
  ])("%s -> 422, nothing written", async (_n, patch) => {
    await expect(createKep(picA, { ...input, ...patch } as never, { now: NOW })).rejects.toMatchObject({ status: 422 });
    expect(client.createRecords).not.toHaveBeenCalled();
  });
  it("accepts yesterday and today", async () => {
    await expect(createKep(picA, { ...input, tanggalMulai: "2026-11-05" }, { now: NOW })).resolves.toBeTruthy();
  });
  it("unknown paroki record 404", async () => {
    store[T.paroki] = [];
    await expect(createKep(picA, input, { now: NOW })).rejects.toMatchObject({ status: 404 });
    expect(client.createRecords).not.toHaveBeenCalled();
  });
  it("a complete KEP with the same paroki and angkatan -> 409", async () => {
    await createKep(picA, input, { now: NOW });
    const n = vi.mocked(client.createRecords).mock.calls.length;
    await expect(createKep(picA, { ...input, tanggalMulai: "2027-02-01" }, { now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(vi.mocked(client.createRecords).mock.calls.length).toBe(n);
  });
  it("a legacy Events row with the same name (no audit trail of ours) is never adopted -> 409", async () => {
    store[T.events] = [{ id: "recEVLEGACY000001", fields: { [F.events.namaAcara]: "KEP PAROKI PANDU ANGKATAN 9" } }];
    await expect(createKep(picA, input, { now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(client.createRecords).not.toHaveBeenCalled();
  });
  it("concurrent identical requests do not both write", async () => {
    const res = await Promise.allSettled([createKep(picA, input, { now: NOW }), createKep(picA, input, { now: NOW })]);
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(rows(T.events)).toHaveLength(1);
    expect(rows(T.subEvent)).toHaveLength(28);
  });
});

describe("createKep partial failure and idempotent retry", () => {
  it("reports exactly what was created and a retry resumes without duplicates", async () => {
    const real = vi.mocked(client.createRecords).getMockImplementation()!;
    let subCalls = 0;
    vi.mocked(client.createRecords).mockImplementation(async (t, r, e) => {
      if (t === T.subEvent && ++subCalls === 2) throw new Error("Airtable request failed: HTTP 500");
      return real(t, r, e);
    });
    const err = await createKep(picA, input, { now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(KepPartialError);
    expect(err.created.eventId).toBe(rows(T.events)[0].id);
    expect(err.created.eventKepId).toBe(rows(T.eventKep)[0].id);
    expect(err.created.penyelenggaraId).toBe(rows(T.penyelenggaraKep)[0].id);
    expect(err.created.subEventIds).toHaveLength(10);
    expect(rows(T.subEvent)).toHaveLength(10);
    expect(invalidateKepCache).toHaveBeenCalled();

    vi.mocked(client.createRecords).mockImplementation(real);
    const r = await createKep(picA, input, { now: NOW });
    expect(r.eventId).toBe(err.created.eventId);
    expect(r.eventKepId).toBe(err.created.eventKepId);
    expect(r.subEventIds).toHaveLength(28);
    expect(rows(T.events)).toHaveLength(1);
    expect(rows(T.eventKep)).toHaveLength(1);
    expect(rows(T.penyelenggaraKep)).toHaveLength(1);
    expect(rows(T.subEvent)).toHaveLength(28);
    expect(new Set(rows(T.subEvent).map((s) => s.fields[F.subEvent.urutan])).size).toBe(28);
    expect(rows(T.auditKep).filter((a) => a.fields[F.auditKep.aksi] === "create_kep")).toHaveLength(1);
  });

  it("failure before Events exists leaves a clean resume", async () => {
    const real = vi.mocked(client.createRecords).getMockImplementation()!;
    vi.mocked(client.createRecords).mockImplementation(async (t, r, e) => {
      if (t === T.events) throw new Error("Airtable request failed: HTTP 500");
      return real(t, r, e);
    });
    const err = await createKep(picA, input, { now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(KepPartialError);
    expect(err.created.eventId).toBeUndefined();
    vi.mocked(client.createRecords).mockImplementation(real);
    const r = await createKep(picA, input, { now: NOW });
    expect(r.subEventIds).toHaveLength(28);
    expect(rows(T.events)).toHaveLength(1);
    expect(rows(T.penyelenggaraKep)).toHaveLength(1);
  });

  it("never deletes anything", async () => {
    await createKep(picA, input, { now: NOW });
    expect(Object.keys(client)).not.toContain("deleteRecords");
  });
});
