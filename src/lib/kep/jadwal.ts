import "server-only";
import { getRecord, listRecords, updateRecords } from "@/lib/airtable/client";
import { F, T, pickAllowedForRole } from "@/lib/airtable/schema";
import { assertKepInScope, assertSubEventInScope, listPesertaInScope, requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { logAudit } from "@/lib/audit/log";
import { HttpError } from "@/lib/http/errors";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { invalidateTable } from "@/lib/airtable/cache";
import { listPewarta } from "@/lib/pewarta/profile";

const REC_ID = /^rec[A-Za-z0-9]{10,}$/;
const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_PENGAJAR_PER_PERTEMUAN = 10;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const day = (v: unknown) => str(v).slice(0, 10);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export const TERKUNCI = "Jadwal pewarta terkunci setelah disetujui";

/**
 * PIC of the owning paroki (Admin Paroki 403, other parish 404) while the KEP is Diajukan only: after approval the PIC could
 * otherwise toggle an assignment to unlock a pewarta's phone number. SEP may edit any KEP that is not Ditolak (audited with its role).
 */
async function scope(actor: Session, eventKepId: string, fresh = false) {
  requireRole(actor, ["PIC", "SEP"]);
  const { eventKep } = await assertKepInScope(actor, eventKepId, { fresh });
  const status = str(eventKep.fields[F.eventKep.statusPersetujuan]);
  return {
    eventIds: ids(eventKep.fields[F.eventKep.events]),
    mulai: day(eventKep.fields[F.eventKep.tanggalMulai]),
    terkunci: actor.role === "SEP" ? status === "Ditolak" : status !== "Diajukan",
    // Dates and times: PIC while Diajukan or Disetujui (the pewarta stay locked after approval), SEP on anything not rejected.
    waktuTerkunci: actor.role === "SEP" ? status === "Ditolak" : status !== "Diajukan" && status !== "Disetujui",
  };
}

export type JadwalItem = { id: string; urutan: number; agenda: string; tanggal: string; jamMulai: string; jamSelesai: string; pengajarIds: string[] };
/** `terkunci`: pewarta assignment locked. `waktuTerkunci`: tanggal / jam locked (a separate, looser rule). `mulai`: KEP start date (lower bound for dates). */
export type Jadwal = { pertemuan: JadwalItem[]; opsi: { id: string; nama: string }[]; terkunci: boolean; waktuTerkunci: boolean; mulai: string };

/** Pertemuan of the KEP with their current pewarta, plus the active pewarta that can be assigned (names only). */
export async function getJadwal(actor: Session, eventKepId: string): Promise<Jadwal> {
  const { eventIds, terkunci, waktuTerkunci, mulai } = await scope(actor, eventKepId);
  const [subs, pewarta] = await Promise.all([
    listRecords(T.subEvent, { fields: [F.subEvent.acara, F.subEvent.agenda, F.subEvent.tanggal, F.subEvent.jamMulai, F.subEvent.jamSelesai, F.subEvent.urutan, F.subEvent.pengajar] }),
    listPewarta(actor),
  ]);
  const pertemuan = subs
    .filter((s) => ids(s.fields[F.subEvent.acara]).some((e) => eventIds.includes(e)))
    .map((s) => ({
      id: s.id,
      urutan: Number(s.fields[F.subEvent.urutan]) || 0,
      agenda: str(s.fields[F.subEvent.agenda]),
      tanggal: day(s.fields[F.subEvent.tanggal]),
      jamMulai: str(s.fields[F.subEvent.jamMulai]),
      jamSelesai: str(s.fields[F.subEvent.jamSelesai]),
      pengajarIds: ids(s.fields[F.subEvent.pengajar]),
    }))
    .sort((a, b) => a.tanggal.localeCompare(b.tanggal) || a.urutan - b.urutan || a.id.localeCompare(b.id));
  return { pertemuan, opsi: pewarta.map((p) => ({ id: p.id, nama: p.nama })), terkunci, waktuTerkunci, mulai };
}

type Marker = { opId?: unknown; t?: unknown; kepId?: unknown; ids?: unknown };
async function markers(subEventId: string): Promise<{ aksi: string; m: Marker }[]> {
  const AU = F.auditKep;
  const rows = await listRecords(T.auditKep, {
    fields: [AU.aksi, AU.targetId, AU.sesudah],
    filterByFormula: `AND({${AU.aksi}}="pengajar_set",{${AU.targetId}}="${subEventId}")`,
  });
  const out: { aksi: string; m: Marker }[] = [];
  for (const r of rows) {
    if (r.fields[AU.aksi] !== "pengajar_set" || r.fields[AU.targetId] !== subEventId) continue;
    try {
      out.push({ aksi: "pengajar_set", m: JSON.parse(str(r.fields[AU.sesudah])) as Marker });
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

/**
 * Replaces the Pengajar links of ONE pertemuan with active Data Pengajar KEP records. The pertemuan must hang under
 * this KEP's events (ids from URL/body are never trusted). Audit first (abort when it fails), idempotent per opId.
 */
export async function assignPengajar(actor: Session, eventKepId: string, subEventId: string, pengajarIds: string[], opId: string): Promise<{ pengajarIds: string[] }> {
  const { eventIds, terkunci } = await scope(actor, eventKepId, true); // the lock depends on the status: fresh read
  if (terkunci) throw new HttpError(409, TERKUNCI);
  if (typeof opId !== "string" || !OP_ID.test(opId)) throw new HttpError(422, "opId tidak valid");
  // Scope-checked fetch (404 for foreign / malformed / unknown), then it must hang under THIS KEP's events.
  const { subEvent: sub } = await assertSubEventInScope(actor, subEventId);
  if (!ids(sub.fields[F.subEvent.acara]).some((e) => eventIds.includes(e))) throw new HttpError(404);

  const want = [...new Set(pengajarIds)];
  if (!Array.isArray(pengajarIds) || pengajarIds.length > MAX_PENGAJAR_PER_PERTEMUAN || want.some((p) => typeof p !== "string" || !REC_ID.test(p)))
    throw new HttpError(422, "Pilihan pewarta tidak valid");
  const aktif = new Set((await listPewarta(actor)).map((p) => p.id));
  if (!want.every((p) => aktif.has(p))) throw new HttpError(422, "Pewarta tidak ditemukan atau tidak aktif");

  const cur = ids(sub.fields[F.subEvent.pengajar]);
  const mine = (await markers(subEventId)).map((x) => x.m).filter((m) => m.opId === opId);
  const prev = mine.sort((a, b) => Number(a.t ?? 0) - Number(b.t ?? 0)).at(-1);
  let aksi = "pengajar_set";
  if (prev) {
    if (prev.kepId !== eventKepId || !Array.isArray(prev.ids) || !sameSet(ids(prev.ids), want)) throw new HttpError(409, "opId sudah dipakai untuk permintaan lain");
    if (sameSet(cur, want)) return { pengajarIds: cur };
    const t = Number(prev.t ?? 0);
    const newer = (await markers(subEventId)).some(({ m }) => m.opId !== opId && Number(m.t ?? 0) >= t);
    if (newer) return { pengajarIds: cur }; // a later save replaced this one: do not resurrect it
    aksi = "pengajar_set_ulang";
  }
  await logAudit({
    actorEmail: actor.email,
    action: aksi,
    targetId: subEventId,
    before: { ids: cur },
    after: { opId, t: Date.now(), kepId: eventKepId, ids: want, role: actor.role },
    opId,
  });
  const fail = async (e: unknown): Promise<never> => {
    try {
      await logAudit({ actorEmail: actor.email, action: "pengajar_set_gagal", targetId: subEventId, after: { opId, t: Date.now() }, opId });
    } catch {
      console.error("audit of failed pengajar write also failed");
    }
    throw e;
  };
  try {
    await updateRecords(T.subEvent, [{ id: subEventId, fields: pickAllowedForRole(T.subEvent, actor.role, { [F.subEvent.pengajar]: want }) }]);
    const back = ids((await getRecord(T.subEvent, subEventId)).fields[F.subEvent.pengajar]);
    if (!sameSet(back, want)) return await fail(new HttpError(503, "Penugasan belum tersimpan. Coba lagi."));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return fail(e);
  }
  invalidateKepCache();
  return { pengajarIds: want };
}


// ---------------------------------------------------------------------------------------------
// Tanggal / jam of one pertemuan (spec §5: "PIC hanya menyesuaikan tanggal bila perlu")
// ---------------------------------------------------------------------------------------------
export const WAKTU_TERKUNCI = "Jadwal tidak dapat diubah karena KEP ini ditolak";
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export type Waktu = { tanggal: string; jamMulai: string; jamSelesai: string };

/** A real calendar date (YYYY-MM-DD) as UTC milliseconds, or null. */
function dateMs(v: string): number | null {
  const m = ISO_DATE.exec(v);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === v ? ms : null;
}
const plusOneYear = (v: string): string => {
  const ms = dateMs(v);
  if (ms === null) return "";
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
};

/** Pure validation: ISO date inside [KEP start, KEP start + 1 year] (no bound when the KEP has no start), HH:MM times (both or none), end after start. */
export function validateWaktu(w: Waktu, kepMulai: string): string | null {
  if (typeof w.tanggal !== "string" || dateMs(w.tanggal) === null) return "Tanggal tidak valid";
  if (kepMulai && dateMs(kepMulai) !== null) {
    if (w.tanggal < kepMulai) return "Tanggal tidak boleh sebelum tanggal mulai KEP";
    if (w.tanggal > plusOneYear(kepMulai)) return "Tanggal terlalu jauh dari tanggal mulai KEP (maksimal satu tahun)";
  }
  const a = w.jamMulai, b = w.jamSelesai;
  if (typeof a !== "string" || typeof b !== "string") return "Jam tidak valid";
  if (a === "" && b === "") return null;
  if (a === "" || b === "") return "Isi jam mulai dan jam selesai, atau kosongkan keduanya";
  if (!HHMM.test(a) || !HHMM.test(b)) return "Jam harus berformat JJ:MM (24 jam)";
  if (b <= a) return "Jam selesai harus setelah jam mulai";
  return null;
}

const sameWaktu = (a: Waktu, b: Waktu) => a.tanggal === b.tanggal && a.jamMulai === b.jamMulai && a.jamSelesai === b.jamSelesai;
const waktuOf = (f: Record<string, unknown>): Waktu => ({ tanggal: day(f[F.subEvent.tanggal]), jamMulai: str(f[F.subEvent.jamMulai]), jamSelesai: str(f[F.subEvent.jamSelesai]) });
type WMarker = Marker & Partial<Waktu>;

async function waktuMarkers(subEventId: string): Promise<WMarker[]> {
  const AU = F.auditKep;
  const rows = await listRecords(T.auditKep, {
    fields: [AU.aksi, AU.targetId, AU.sesudah],
    filterByFormula: `AND(OR({${AU.aksi}}="jadwal_set",{${AU.aksi}}="jadwal_set_ulang"),{${AU.targetId}}="${subEventId}")`,
  });
  const out: WMarker[] = [];
  for (const r of rows) {
    if ((r.fields[AU.aksi] !== "jadwal_set" && r.fields[AU.aksi] !== "jadwal_set_ulang") || r.fields[AU.targetId] !== subEventId) continue;
    try {
      out.push(JSON.parse(str(r.fields[AU.sesudah])) as WMarker);
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

const todayWib = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
export const GESER_LEWAT = "Pertemuan yang tanggalnya sudah lewat tidak dapat dipindahkan. Hubungi SEP.";
export const GESER_KEHADIRAN = "Pertemuan ini sudah punya catatan kehadiran sehingga tanggalnya tidak dapat dipindahkan. Hubungi SEP.";
export const GESER_HASIL = "Hasil akhir (lulus / tidak lulus) sudah ditetapkan untuk KEP ini sehingga tanggal pertemuan tidak dapat dipindahkan. Hubungi SEP.";
export const GESER_KE_LEWAT = "Tanggal baru harus setelah hari ini. Pertemuan tidak dapat dipindahkan ke hari ini atau tanggal yang sudah lewat.";

/**
 * PIC only (SEP is exempt, audited with its role): the date drives the attendance denominator and the opening of
 * "Hasil akhir", so a PIC may not move a meeting that already happened or has marks, may not move any date once a
 * result exists, and may not move a meeting to today or the past (that would unlock the penetapan early).
 * One fresh read of this KEP's registrations (marks and results).
 */
async function assertTanggalBolehGeser(actor: Session, eventKepId: string, subEventId: string, dari: string, ke: string): Promise<void> {
  const today = todayWib();
  if (dari && dari < today) throw new HttpError(409, GESER_LEWAT);
  if (ke <= today) throw new HttpError(409, GESER_KE_LEWAT);
  const P = F.pendaftaranEvents;
  const rows = await listPesertaInScope(actor, [P.pertemuanHadir, P.keterangan], eventKepId, { fresh: true });
  if (rows.some((r) => ["LULUS", "TIDAK LULUS"].includes(str(r.fields[P.keterangan]).trim().toUpperCase()))) throw new HttpError(409, GESER_HASIL);
  if (rows.some((r) => ids(r.fields[P.pertemuanHadir]).includes(subEventId))) throw new HttpError(409, GESER_KEHADIRAN);
}

/**
 * Sets Tanggal, Jam Mulai and Jam Selesai of ONE pertemuan of this KEP (never creates, deletes or reorders pertemuan).
 * PIC of the owning paroki while the KEP is Diajukan or Disetujui, SEP unless it is Ditolak, Admin Paroki 403. Audit first
 * (abort when it fails), idempotent per opId bound to the payload. The PATCH response is the verification (no extra read).
 * Warm cache: scope refresh (1) + pertemuan (1) + marker lookup (1) + audit (1) + PATCH (1).
 */
export async function updateWaktu(actor: Session, eventKepId: string, subEventId: string, input: Waktu, opId: string): Promise<Waktu> {
  const { eventIds, waktuTerkunci, mulai } = await scope(actor, eventKepId, true); // the lock depends on the status: fresh read
  if (waktuTerkunci) throw new HttpError(409, WAKTU_TERKUNCI);
  if (typeof opId !== "string" || !OP_ID.test(opId)) throw new HttpError(422, "opId tidak valid");
  const want: Waktu = { tanggal: str(input?.tanggal), jamMulai: str(input?.jamMulai), jamSelesai: str(input?.jamSelesai) };
  const bad = validateWaktu(want, mulai);
  if (bad) throw new HttpError(422, bad);
  const { subEvent: sub } = await assertSubEventInScope(actor, subEventId);
  if (!ids(sub.fields[F.subEvent.acara]).some((e) => eventIds.includes(e))) throw new HttpError(404);

  const cur = waktuOf(sub.fields);
  if (actor.role !== "SEP" && want.tanggal !== cur.tanggal) await assertTanggalBolehGeser(actor, eventKepId, subEventId, cur.tanggal, want.tanggal);
  const mine = (await waktuMarkers(subEventId)).filter((m) => m.opId === opId);
  const prev = [...mine].sort((a, b) => Number(a.t ?? 0) - Number(b.t ?? 0)).at(-1);
  let aksi = "jadwal_set";
  if (prev) {
    if (prev.kepId !== eventKepId || !sameWaktu({ tanggal: str(prev.tanggal), jamMulai: str(prev.jamMulai), jamSelesai: str(prev.jamSelesai) }, want))
      throw new HttpError(409, "opId sudah dipakai untuk permintaan lain");
    if (sameWaktu(cur, want)) return cur;
    const t = Number(prev.t ?? 0);
    const newer = (await waktuMarkers(subEventId)).some((m) => m.opId !== opId && Number(m.t ?? 0) >= t);
    if (newer) return cur; // a later save replaced this one: do not resurrect it
    aksi = "jadwal_set_ulang";
  }
  await logAudit({
    actorEmail: actor.email,
    action: aksi,
    targetId: subEventId,
    before: cur,
    after: { opId, t: Date.now(), kepId: eventKepId, ...want, role: actor.role },
    opId,
  });
  const fail = async (e: unknown): Promise<never> => {
    try {
      await logAudit({ actorEmail: actor.email, action: "jadwal_set_gagal", targetId: subEventId, after: { opId, t: Date.now() }, opId });
    } catch {
      console.error("audit of failed jadwal write also failed");
    }
    throw e;
  };
  try {
    const res = await updateRecords(T.subEvent, [
      {
        id: subEventId,
        fields: pickAllowedForRole(T.subEvent, actor.role, {
          [F.subEvent.tanggal]: want.tanggal,
          [F.subEvent.jamMulai]: want.jamMulai || null,
          [F.subEvent.jamSelesai]: want.jamSelesai || null,
        }),
      },
    ]);
    const back = res.find((r) => r.id === subEventId);
    if (!back || !sameWaktu(waktuOf(back.fields), want)) return await fail(new HttpError(503, "Jadwal belum tersimpan. Coba lagi.", 5));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return fail(e);
  } finally {
    invalidateTable(T.subEvent); // absen sheet, hub, penetapan unlock (last meeting date) and reports see it at once
  }
  invalidateKepCache(T.subEvent);
  return want;
}
