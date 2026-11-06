import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_ID_FIELD, F, T } from "@/lib/airtable/schema";

/**
 * Final fix C1(f): counts Airtable HTTP requests per hot path against a base of realistic size (Pendaftaran
 * Events 3,783 rows, TeamUmat 2,099, Events 233). The fake below honours the formula shapes the app uses
 * (RECORD_ID(), FIND(EventID, ARRAYJOIN(link)), field equality) and charges one request per 100 returned rows
 * (Airtable's page size), one per getRecord and one per 10 written rows. Before/after numbers: task-19a-report.md.
 */
type Row = { id: string; fields: Record<string, unknown> };
const db: Record<string, Row[]> = {};
let requests = 0;
const byTable: Record<string, number> = {};
const charge = (t: string, n = 1) => {
  requests += n;
  byTable[t] = (byTable[t] ?? 0) + n;
};

function evalFormula(table: string, f: string | undefined, rows: Row[]): Row[] {
  if (!f) return rows;
  const recIds = [...f.matchAll(/RECORD_ID\(\)\s*=\s*"(rec[A-Za-z0-9]+)"/g)].map((m) => m[1]);
  if (recIds.length) return rows.filter((r) => recIds.includes(r.id));
  const finds = [...f.matchAll(/FIND\("([^"]+)",ARRAYJOIN\(\{(fld[A-Za-z0-9]+)\}\)\)>0/g)];
  if (finds.length) {
    const evText = new Map((db[T.events] ?? []).map((e) => [e.id, String(e.fields[EVENT_ID_FIELD] ?? "")]));
    return rows.filter((r) => finds.some(([, txt, fld]) => (Array.isArray(r.fields[fld]) ? (r.fields[fld] as string[]) : []).some((id) => (evText.get(id) ?? "").includes(txt))));
  }
  if (table === T.teamUmat && /LOWER\(TRIM/.test(f)) {
    const email = /=\s*"([^"]+)"/.exec(f)?.[1];
    return rows.filter((r) => String(r.fields[F.teamUmat.email] ?? "").toLowerCase() === email);
  }
  if (table === T.teamUmat && /^FIND\("(\d+)",SUBSTITUTE/.test(f)) {
    const wa = /^FIND\("(\d+)"/.exec(f)![1];
    return rows.filter((r) => String(r.fields[F.teamUmat.noWhatsapp] ?? "").replace(/\D/g, "").includes(wa));
  }
  const eqs = [...f.matchAll(/\{(fld[A-Za-z0-9]+)\}\s*=\s*["']([^"']*)["']/g)];
  if (eqs.length) {
    const want = new Map<string, Set<string>>();
    for (const [, fld, v] of eqs) (want.get(fld) ?? want.set(fld, new Set()).get(fld)!).add(v);
    return rows.filter((r) => [...want].every(([fld, vs]) => vs.has(String(r.fields[fld] ?? ""))));
  }
  return rows;
}

vi.mock("@/lib/airtable/client", () => ({
  listRecords: vi.fn(async (table: string, o: { filterByFormula?: string }) => {
    const out = evalFormula(table, o.filterByFormula, db[table] ?? []);
    charge(table, Math.max(1, Math.ceil(out.length / 100)));
    return structuredClone(out);
  }),
  getRecord: vi.fn(async (table: string, id: string) => {
    charge(table);
    const r = (db[table] ?? []).find((x) => x.id === id);
    if (!r) throw new Error("Airtable request failed: HTTP 404");
    return structuredClone(r);
  }),
  createRecords: vi.fn(async (table: string, rows: Record<string, unknown>[]) => {
    charge(table, Math.ceil(rows.length / 10));
    const out = rows.map((fields, i) => ({ id: `recNEW${String((db[table] ??= []).length + i).padStart(11, "0")}`, fields: structuredClone(fields) }));
    db[table].push(...out);
    return structuredClone(out);
  }),
  updateRecords: vi.fn(async (table: string, rows: Row[]) => {
    charge(table, Math.ceil(rows.length / 10));
    for (const r of rows) Object.assign((db[table] ?? []).find((x) => x.id === r.id)!.fields, r.fields);
    return structuredClone(rows.map((r) => (db[table] ?? []).find((x) => x.id === r.id)!));
  }),
}));
vi.mock("@/lib/email", () => ({ sendMail: vi.fn(async () => undefined), mailConfigured: () => false, appBaseUrl: () => "https://kep.test", setMailer: () => undefined }));

import { invalidateKepCache } from "@/lib/kep/readModel";
import { getAbsenSheet, setHadir, setSemuaHadir } from "@/lib/kep/absensi";
import { getKepHub } from "@/lib/kep/hub";
import { registerPeserta } from "@/lib/kep/registration";
import { updateWaktu } from "@/lib/kep/jadwal";
import { tambahWalkIn } from "@/lib/kep/walkin";
import { getKesehatan } from "@/lib/kep/kesehatan";
import { resetRateLimitMemory } from "@/lib/ratelimit";
import type { Session } from "@/lib/auth/session";

const PA = "recPAROKIA0000001";
const ORG = "recORGA0000000001";
const KEP = "recKEPA0000000001";
const EV = "recEVA00000000001";
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const sub = (n: number) => `recSUB${String(n).padStart(10, "0")}`;
const P = F.pendaftaranEvents;

function seed() {
  for (const k of Object.keys(db)) delete db[k];
  db[T.paroki] = Array.from({ length: 40 }, (_, i) => ({ id: i === 0 ? PA : `recPAROKI${String(i).padStart(8, "0")}`, fields: { [F.paroki.nama]: `Paroki ${i}` } }));
  db[T.penyelenggaraKep] = [{ id: ORG, fields: { [F.penyelenggaraKep.paroki]: [PA] } }];
  db[T.eventKep] = [
    { id: KEP, fields: { [F.eventKep.events]: [EV], [F.eventKep.penyelenggara]: [ORG], [F.eventKep.statusPersetujuan]: "Disetujui", [F.eventKep.angkatan]: 1 } },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `recKEPX${String(i).padStart(10, "0")}`, fields: { [F.eventKep.statusPersetujuan]: "Disetujui" } })),
  ];
  db[T.events] = [
    { id: EV, fields: { [F.events.namaAcara]: "KEP PAROKI 0 ANGKATAN 1", [F.events.kelompokAcara]: "KEP", [EVENT_ID_FIELD]: "2611-0001" } },
    ...Array.from({ length: 232 }, (_, i) => ({ id: `recEVX${String(i).padStart(11, "0")}`, fields: { [F.events.namaAcara]: `Acara ${i}`, [EVENT_ID_FIELD]: `2611-9${String(i).padStart(3, "0")}` } })),
  ];
  db[T.subEvent] = [
    ...Array.from({ length: 28 }, (_, i) => ({ id: sub(i + 1), fields: { [F.subEvent.acara]: [EV], [F.subEvent.agenda]: `Bab ${i + 1}`, [F.subEvent.urutan]: i + 1, [F.subEvent.tanggal]: "2026-11-07" } })),
    ...Array.from({ length: 300 }, (_, i) => ({ id: `recSUBX${String(i).padStart(10, "0")}`, fields: { [F.subEvent.acara]: [`recEVX${String(i % 232).padStart(11, "0")}`] } })),
  ];
  db[T.teamUmat] = Array.from({ length: 2099 }, (_, i) => ({ id: `recTEAM${String(i).padStart(10, "0")}`, fields: { [F.teamUmat.namaLengkap]: `Orang ${i}`, [F.teamUmat.email]: `o${i}@x.id` } }));
  db[T.pendaftaranEvents] = Array.from({ length: 3783 }, (_, i) => ({
    id: `recPEND${String(i).padStart(10, "0")}`,
    fields: {
      [P.event]: [i < 40 ? EV : `recEVX${String(i % 232).padStart(11, "0")}`],
      [P.teamUmat]: [`recTEAM${String(i % 2099).padStart(10, "0")}`],
      [P.statusPendaftaran]: "Confirmed",
      [P.kategoriKepesertaan]: "Peserta",
    },
  }));
  db[T.auditKep] = Array.from({ length: 500 }, (_, i) => ({ id: `recAUD${String(i).padStart(11, "0")}`, fields: { [F.auditKep.aksi]: "x", [F.auditKep.targetId]: `t${i}` } }));
  db[T.akunKep] = [];
}

const measure = async (fn: () => Promise<unknown>) => {
  requests = 0;
  for (const k of Object.keys(byTable)) delete byTable[k];
  await fn();
  return { requests, byTable: { ...byTable } };
};
const report: Record<string, number> = {};

beforeEach(() => {
  vi.stubEnv("ABSEN_RECHECK_MS", "0");
  seed();
  invalidateKepCache();
});

describe("Airtable requests per hot path (final fix C1f)", () => {
  it("absen sheet GET: cold <= 8, warm <= 1 (whole Pendaftaran table never read)", async () => {
    const cold = await measure(() => getAbsenSheet(pic, KEP, sub(1)));
    const warm = await measure(() => getAbsenSheet(pic, KEP, sub(1)));
    report["absen GET cold"] = cold.requests;
    report["absen GET warm"] = warm.requests;
    expect(cold.byTable[T.pendaftaranEvents]).toBe(1); // 40 rows of this KEP, one page
    expect(cold.requests).toBeLessThanOrEqual(8);
    expect(warm.requests).toBeLessThanOrEqual(1);
  });
  it("one setHadir tap on a warm cache: <= 4 requests", async () => {
    await getAbsenSheet(pic, KEP, sub(1));
    const tap = await measure(() => setHadir(pic, KEP, sub(1), "recPEND0000000003", true, "op-count-000001"));
    report["setHadir warm"] = tap.requests;
    expect(tap.requests).toBeLessThanOrEqual(4);
    const sheet = await getAbsenSheet(pic, KEP, sub(1));
    expect(sheet.peserta.find((p) => p.id === "recPEND0000000003")?.hadir).toBe(true); // the tap is visible at once
  });
  it("'tandai semua' for 40 peserta on a warm cache: <= 20 requests (batches of 10)", async () => {
    await getAbsenSheet(pic, KEP, sub(1));
    const all = await measure(() => setSemuaHadir(pic, KEP, sub(1), "op-count-semua01"));
    report["semua 40 warm"] = all.requests;
    expect(all.requests).toBeLessThanOrEqual(20);
    expect((await getAbsenSheet(pic, KEP, sub(1))).hadirCount).toBe(40);
  });
  it("hub view: cold <= 8, warm <= 2", async () => {
    const cold = await measure(() => getKepHub(pic, KEP));
    const warm = await measure(() => getKepHub(pic, KEP));
    report["hub cold"] = cold.requests;
    report["hub warm"] = warm.requests;
    expect(cold.byTable[T.pendaftaranEvents]).toBe(1);
    expect(cold.byTable[T.subEvent]).toBe(1);
    expect(cold.requests).toBeLessThanOrEqual(8);
    expect(warm.requests).toBeLessThanOrEqual(2);
  });
  it("registration of a new person: cold <= 12, warm <= 7 (the commit route's per-row budget)", async () => {
    const input = (n: number) => ({
      namaLengkap: `Peserta Baru ${"ABCDEFGH"[n]}`,
      jenisKelamin: "Wanita",
      tanggalLahir: "1985-04-12",
      wa: `0812-3456-78${n}`,
      email: `baru${n}@example.com`,
      alamat: "Jl. Merdeka 1, Bandung",
      parokiAsalId: PA,
      statusPernikahan: "Menikah",
      kontakDarurat: "Yohanes 081111111111",
      pendukungDoa: [
        { nama: "Ana", kontak: "081200000001" },
        { nama: "Budi", kontak: "081200000002" },
      ],
      persetujuanKesehatan: true,
      riwayatPenyakit: "x",
    });
    const cold = await measure(() => registerPeserta(EV, input(1), { actorEmail: "pic@x.id" }));
    const warm = await measure(() => registerPeserta(EV, input(2), { actorEmail: "pic@x.id" }));
    report["registration cold"] = cold.requests;
    report["registration warm"] = warm.requests;
    expect(cold.requests).toBeLessThanOrEqual(12);
    expect(warm.requests).toBeLessThanOrEqual(7);
  });
  it("jadwal tanggal/jam edit (Final fix B, I7): warm <= 6 requests", async () => {
    await getAbsenSheet(pic, KEP, sub(1)); // warm scope + sub events
    const w = await measure(() => updateWaktu(pic, KEP, sub(2), { tanggal: "2026-11-09", jamMulai: "19:00", jamSelesai: "21:00" }, "op-count-jadwal1"));
    report["jadwal edit warm"] = w.requests;
    expect(w.requests).toBeLessThanOrEqual(6);
    expect((await listPertemuanDate(sub(2)))).toBe("2026-11-09"); // the next read already sees it
  });
  it("walk-in (Final fix B, I8): warm <= 12 requests, one registration plus one tap; the next sheet read is cheap", async () => {
    resetRateLimitMemory();
    await getAbsenSheet(pic, KEP, sub(1));
    await registerPeserta(EV, { namaLengkap: "Pemanasan", wa: "0812-0000-0001", email: "p@example.com", jenisKelamin: "Pria", tanggalLahir: "1985-04-12", alamat: "Jl. Merdeka 1", parokiAsalId: PA, statusPernikahan: "Menikah", kontakDarurat: "Ibu 0811", pendukungDoa: [{ nama: "Ana", kontak: "081200000001" }, { nama: "Budi", kontak: "081200000002" }] }, { actorEmail: "pic@x.id" });
    const w = await measure(() => tambahWalkIn(pic, KEP, sub(1), { namaLengkap: "Tamu Datang", wa: "0813-9999-0001" }, "op-count-walkin1"));
    report["walk-in warm"] = w.requests;
    expect(w.requests).toBeLessThanOrEqual(12);
    const after = await measure(() => getAbsenSheet(pic, KEP, sub(1)));
    expect(after.requests).toBeLessThanOrEqual(2);
  });
  it("health screen (Final fix B): first view <= 5 incl. audit, a reload inside the audit window <= 2", async () => {
    resetRateLimitMemory();
    await getAbsenSheet(pic, KEP, sub(1)); // warm scope
    const first = await measure(() => getKesehatan(pic, KEP));
    const again = await measure(() => getKesehatan(pic, KEP));
    report["kesehatan first"] = first.requests;
    report["kesehatan reload"] = again.requests;
    expect(first.byTable[T.pendaftaranEvents]).toBe(1); // one KEP's rows, never the whole table
    expect(first.requests).toBeLessThanOrEqual(5);
    expect(again.requests).toBeLessThanOrEqual(2);
    expect(again.byTable[T.auditKep] ?? 0).toBe(0);
    process.stderr.write("[airtable-calls] " + JSON.stringify(report) + "\n");
  });
});

async function listPertemuanDate(id: string) {
  const { listPertemuan } = await import("@/lib/kep/absensi");
  return (await listPertemuan(pic, KEP)).items.find((p) => p.id === id)?.tanggal;
}
