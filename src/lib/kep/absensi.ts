import "server-only";
import { getRecord, listRecords, updateRecords, type AtRecord } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { assertKepInScope, listPesertaInScope, requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { logAudit } from "@/lib/audit/log";
import { HttpError } from "@/lib/http/errors";
import { invalidateKepCache } from "@/lib/kep/readModel";

const REC_ID = /^rec[A-Za-z0-9]{10,}$/;
export const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const MUNDUR = "MENGUNDURKAN DIRI";
export type Hasil = "LULUS" | "TIDAK LULUS";
const MAX_SEMUA = 500;
const P = F.pendaftaranEvents;

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const day = (v: unknown) => str(v).slice(0, 10);
const INACTIVE = new Set(["batal", "dobel daftar"]);
const isCountable = (r: AtRecord) =>
  !INACTIVE.has(str(r.fields[P.statusPendaftaran]).toLowerCase()) && str(r.fields[P.kategoriKepesertaan]).toLowerCase() !== "panitia";
const isMundur = (r: AtRecord) => str(r.fields[P.keterangan]) === MUNDUR;

/** Today's calendar date in Asia/Jakarta (UTC+7, no DST). */
const todayWib = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

// ---- per-pendaftaranId serial queue (per process; cross-instance writers are last-writer-wins) ----
const tails = new Map<string, Promise<void>>();
function serial<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

// ---- opId markers in AuditKEP (same approach as the import commit) ----
type Marker = Record<string, unknown> & { opId?: string; t?: number };
/** The success marker of this opId, unless a later "_gagal" row says the write failed. */
async function findMarker(aksi: string, targetId: string, opId: string): Promise<Marker | null> {
  const AU = F.auditKep;
  const rows = await listRecords(T.auditKep, {
    fields: [AU.aksi, AU.targetId, AU.sesudah],
    filterByFormula: `AND(OR({${AU.aksi}}="${aksi}",{${AU.aksi}}="${aksi}_gagal"),{${AU.targetId}}="${targetId}")`,
  });
  let ok: Marker | null = null;
  let failedAt = -1;
  for (const r of rows) {
    const a = r.fields[AU.aksi];
    if (r.fields[AU.targetId] !== targetId || (a !== aksi && a !== `${aksi}_gagal`)) continue;
    let m: Marker;
    try {
      m = JSON.parse(String(r.fields[AU.sesudah] ?? "")) as Marker;
    } catch {
      continue;
    }
    if (m.opId !== opId) continue;
    if (a === aksi) {
      if (!ok || (m.t ?? 0) >= (ok.t ?? 0)) ok = m;
    } else failedAt = Math.max(failedAt, m.t ?? 0);
  }
  return ok && (ok.t ?? 0) > failedAt ? ok : null;
}

async function auditFailure(actorEmail: string, aksi: string, targetId: string, opId: string) {
  try {
    await logAudit({ actorEmail, action: `${aksi}_gagal`, targetId, after: { opId, t: Date.now() } });
  } catch {
    console.error("audit of failed attendance write also failed");
  }
}

// ---- scope ----
type Ctx = { eventKepId: string; eventIds: string[] };

/** PIC/ADMIN of the owning paroki (SEP: 403, other parish: 404), KEP must be Disetujui (409). */
async function scope(actor: Session, eventKepId: string): Promise<Ctx> {
  requireRole(actor, ["PIC", "ADMIN"]);
  const { eventKep } = await assertKepInScope(actor, eventKepId);
  if (str(eventKep.fields[F.eventKep.statusPersetujuan]) !== "Disetujui") throw new HttpError(409, "KEP belum disetujui");
  return { eventKepId, eventIds: ids(eventKep.fields[F.eventKep.events]) };
}

function checkOp(opId: unknown): asserts opId is string {
  if (typeof opId !== "string" || !OP_ID.test(opId)) throw new HttpError(422, "opId tidak valid");
}

async function fetch404(table: string, id: string): Promise<AtRecord> {
  if (typeof id !== "string" || !REC_ID.test(id)) throw new HttpError(404);
  try {
    return await getRecord(table, id);
  } catch {
    throw new HttpError(404);
  }
}

/** The pertemuan must hang under one of this KEP's events (ids from the URL / body are never trusted). */
async function ownSubEvent(ctx: Ctx, subEventId: string): Promise<AtRecord> {
  const sub = await fetch404(T.subEvent, subEventId);
  if (!ids(sub.fields[F.subEvent.acara]).some((e) => ctx.eventIds.includes(e))) throw new HttpError(404);
  return sub;
}

function ownPeserta(ctx: Ctx, rec: AtRecord): AtRecord {
  if (!ids(rec.fields[P.event]).some((e) => ctx.eventIds.includes(e)) || !isCountable(rec)) throw new HttpError(404);
  return rec;
}

export type AbsenSheet = {
  subEvent: { id: string; agenda: string; tanggal: string };
  peserta: { id: string; nama: string; hadir: boolean; mundur: boolean }[];
  hadirCount: number;
  aktifCount: number;
};

async function pesertaRows(actor: Session, ctx: Ctx): Promise<AtRecord[]> {
  const rows = await listPesertaInScope(actor, [P.event, P.teamUmat, P.statusPendaftaran, P.kategoriKepesertaan, P.keterangan, P.pertemuanHadir], ctx.eventKepId);
  return rows.filter(isCountable);
}

export async function getAbsenSheet(actor: Session, eventKepId: string, subEventId: string): Promise<AbsenSheet> {
  const ctx = await scope(actor, eventKepId);
  const sub = await ownSubEvent(ctx, subEventId);
  const rows = await pesertaRows(actor, ctx);
  const people = await listRecords(T.teamUmat, { fields: [F.teamUmat.namaLengkap] });
  const nama = new Map(people.map((p) => [p.id, str(p.fields[F.teamUmat.namaLengkap]).trim()]));
  const peserta = rows
    .map((r) => ({
      id: r.id,
      nama: nama.get(ids(r.fields[P.teamUmat])[0] ?? "") || "(tanpa nama)",
      hadir: ids(r.fields[P.pertemuanHadir]).includes(subEventId),
      mundur: isMundur(r),
    }))
    .sort((a, b) => a.nama.localeCompare(b.nama, "id", { sensitivity: "base" }) || a.id.localeCompare(b.id));
  const aktif = peserta.filter((p) => !p.mundur);
  return {
    subEvent: { id: sub.id, agenda: str(sub.fields[F.subEvent.agenda]), tanggal: day(sub.fields[F.subEvent.tanggal]) },
    peserta,
    hadirCount: aktif.filter((p) => p.hadir).length,
    aktifCount: aktif.length,
  };
}

/** Set semantics on the link array: add when absent (true) / remove only this SubEvent (false). */
const nextLinks = (cur: string[], sub: string, hadir: boolean) => (hadir ? (cur.includes(sub) ? cur : [...cur, sub]) : cur.filter((x) => x !== sub));

async function setHadirCore(actor: Session, ctx: Ctx, subEventId: string, pendaftaranId: string, hadir: boolean, opId: string, checkMarker: boolean): Promise<boolean> {
  if (typeof pendaftaranId !== "string" || !REC_ID.test(pendaftaranId)) throw new HttpError(404);
  return serial(pendaftaranId, async () => {
    const rec = ownPeserta(ctx, await fetch404(T.pendaftaranEvents, pendaftaranId));
    if (isMundur(rec)) throw new HttpError(409, "Peserta sudah mengundurkan diri");
    let cur = ids(rec.fields[P.pertemuanHadir]);
    if (cur.includes(subEventId) === hadir) return false;
    if (checkMarker && (await findMarker("absen_set", pendaftaranId, opId))) return false;
    await logAudit({
      actorEmail: actor.email,
      action: "absen_set",
      targetId: pendaftaranId,
      before: { subEventId, hadir: !hadir },
      after: { opId, t: Date.now(), kepId: ctx.eventKepId, subEventId, hadir },
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await updateRecords(T.pendaftaranEvents, [{ id: pendaftaranId, fields: { [P.pertemuanHadir]: nextLinks(cur, subEventId, hadir) } }]);
        cur = ids((await getRecord(T.pendaftaranEvents, pendaftaranId)).fields[P.pertemuanHadir]);
        if (cur.includes(subEventId) === hadir) return true;
      }
    } catch (e) {
      await auditFailure(actor.email, "absen_set", pendaftaranId, opId);
      throw e;
    }
    await auditFailure(actor.email, "absen_set", pendaftaranId, opId);
    throw new HttpError(503, "Absensi belum tersimpan. Coba lagi.");
  });
}

export async function setHadir(actor: Session, eventKepId: string, subEventId: string, pendaftaranId: string, hadir: boolean, opId: string): Promise<{ hadir: boolean }> {
  const ctx = await scope(actor, eventKepId);
  checkOp(opId);
  if (typeof hadir !== "boolean") throw new HttpError(422, "Nilai hadir tidak valid");
  await ownSubEvent(ctx, subEventId);
  await setHadirCore(actor, ctx, subEventId, pendaftaranId, hadir, opId, true);
  return { hadir };
}

/** Marks every active (non-mundur) peserta present, one by one. Replays of the same opId answer from the summary row. */
export async function setSemuaHadir(actor: Session, eventKepId: string, subEventId: string, opId: string): Promise<{ updated: number }> {
  const ctx = await scope(actor, eventKepId);
  checkOp(opId);
  await ownSubEvent(ctx, subEventId);
  const earlier = await findMarker("absen_semua", subEventId, opId);
  if (earlier && typeof earlier.updated === "number") return { updated: earlier.updated };
  const todo = (await pesertaRows(actor, ctx)).filter((r) => !isMundur(r) && !ids(r.fields[P.pertemuanHadir]).includes(subEventId));
  if (todo.length > MAX_SEMUA) throw new HttpError(422, "Terlalu banyak peserta untuk satu kali proses");
  let updated = 0;
  for (const r of todo) {
    try {
      if (await setHadirCore(actor, ctx, subEventId, r.id, true, `${opId}:${r.id}`, false)) updated++;
    } catch (e) {
      // mundur between the list and the write: skip. Anything else stops the run (a retry resumes it).
      if (!(e instanceof HttpError && (e.status === 409 || e.status === 404))) throw e;
    }
  }
  try {
    await logAudit({ actorEmail: actor.email, action: "absen_semua", targetId: subEventId, after: { opId, t: Date.now(), kepId: eventKepId, updated } });
  } catch {
    /* the per-peserta rows already exist; a replay is value-idempotent */
  }
  return { updated };
}

async function setKeterangan(
  actor: Session,
  eventKepId: string,
  pendaftaranId: string,
  opId: string,
  aksi: "peserta_mundur" | "hasil_tetap",
  nilai: string,
  guard: (ctx: Ctx, rec: AtRecord) => Promise<void>,
): Promise<void> {
  const ctx = await scope(actor, eventKepId);
  checkOp(opId);
  if (typeof pendaftaranId !== "string" || !REC_ID.test(pendaftaranId)) throw new HttpError(404);
  await serial(pendaftaranId, async () => {
    const rec = ownPeserta(ctx, await fetch404(T.pendaftaranEvents, pendaftaranId));
    const sebelum = str(rec.fields[P.keterangan]);
    if (sebelum === nilai) return;
    await guard(ctx, rec);
    if (await findMarker(aksi, pendaftaranId, opId)) return;
    await logAudit({ actorEmail: actor.email, action: aksi, targetId: pendaftaranId, before: { keterangan: sebelum || null }, after: { opId, t: Date.now(), kepId: eventKepId, keterangan: nilai } });
    try {
      await updateRecords(T.pendaftaranEvents, [{ id: pendaftaranId, fields: { [P.keterangan]: nilai } }]);
      const back = str((await getRecord(T.pendaftaranEvents, pendaftaranId)).fields[P.keterangan]);
      if (back !== nilai) throw new HttpError(503, "Perubahan belum tersimpan. Coba lagi.");
    } catch (e) {
      await auditFailure(actor.email, aksi, pendaftaranId, opId);
      throw e;
    } finally {
      invalidateKepCache();
    }
  });
}

export async function mundurkanPeserta(actor: Session, eventKepId: string, pendaftaranId: string, opId: string): Promise<void> {
  return setKeterangan(actor, eventKepId, pendaftaranId, opId, "peserta_mundur", MUNDUR, async (_ctx, rec) => {
    const k = str(rec.fields[P.keterangan]);
    if (k === "LULUS" || k === "TIDAK LULUS") throw new HttpError(409, "Hasil akhir sudah ditetapkan");
  });
}

export async function tetapkanHasil(actor: Session, eventKepId: string, pendaftaranId: string, hasil: Hasil, opId: string): Promise<void> {
  if (hasil !== "LULUS" && hasil !== "TIDAK LULUS") {
    requireRole(actor, ["PIC", "ADMIN"]);
    throw new HttpError(422, "Hasil tidak valid");
  }
  return setKeterangan(actor, eventKepId, pendaftaranId, opId, "hasil_tetap", hasil, async (ctx, rec) => {
    if (isMundur(rec)) throw new HttpError(409, "Peserta sudah mengundurkan diri");
    const subs = await listRecords(T.subEvent, { fields: [F.subEvent.acara, F.subEvent.tanggal] });
    const dates = subs.filter((s) => ids(s.fields[F.subEvent.acara]).some((e) => ctx.eventIds.includes(e))).map((s) => day(s.fields[F.subEvent.tanggal])).filter(Boolean);
    const last = dates.sort().at(-1);
    if (!last || todayWib() < last) throw new HttpError(409, "Hasil akhir baru bisa ditetapkan mulai tanggal pertemuan terakhir");
  });
}
