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
const MAX_SEMUA = 60;
const NAME_CHUNK = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = F.pendaftaranEvents;

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const day = (v: unknown) => str(v).slice(0, 10);
const INACTIVE = new Set(["batal", "dobel daftar"]);
const isCountable = (r: AtRecord) =>
  !INACTIVE.has(str(r.fields[P.statusPendaftaran]).toLowerCase()) && str(r.fields[P.kategoriKepesertaan]).toLowerCase() !== "panitia";
const norm = (v: unknown) => str(v).trim().toUpperCase();
const isMundur = (r: AtRecord) => norm(r.fields[P.keterangan]) === MUNDUR;
const ENUM = new Set(["LULUS", "TIDAK LULUS", MUNDUR]);
/** Audit never stores free text: an enum value, "lainnya" or null. */
const auditKet = (n: string) => (!n ? null : ENUM.has(n) ? n : "lainnya");

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

// ---- opId markers in AuditKEP (opId is also stored in the Op ID field; payload lives in Sesudah) ----
type Marker = Record<string, unknown> & { opId?: string; t?: number };
type AuditRow = { aksi: string; m: Marker };
const CONFLICT = () => new HttpError(409, "opId sudah dipakai untuk permintaan lain");

async function auditRows(aksis: string[], targetId: string, opId?: string): Promise<AuditRow[]> {
  const AU = F.auditKep;
  const rows = await listRecords(T.auditKep, {
    fields: [AU.aksi, AU.targetId, AU.sesudah],
    filterByFormula: `AND(OR(${aksis.map((a) => `{${AU.aksi}}="${a}"`).join(",")}),{${AU.targetId}}="${targetId}"${opId ? `,{${AU.opId}}="${opId}"` : ""})`,
  });
  const out: AuditRow[] = [];
  for (const r of rows) {
    const aksi = String(r.fields[AU.aksi] ?? "");
    if (r.fields[AU.targetId] !== targetId || !aksis.includes(aksi)) continue;
    try {
      const m = JSON.parse(String(r.fields[AU.sesudah] ?? "")) as Marker;
      if (!opId || m.opId === opId) out.push({ aksi, m });
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

/** Latest success marker of this opId (aksi or aksi_ulang), unless a later "_gagal" row says the write failed. */
async function findMarker(aksi: string, targetId: string, opId: string): Promise<Marker | null> {
  const rows = await auditRows([aksi, `${aksi}_ulang`, `${aksi}_gagal`], targetId, opId);
  let ok: Marker | null = null;
  let failedAt = -1;
  for (const { aksi: a, m } of rows) {
    if (a === `${aksi}_gagal`) failedAt = Math.max(failedAt, m.t ?? 0);
    else if (!ok || (m.t ?? 0) >= (ok.t ?? 0)) ok = m;
  }
  return ok && (ok.t ?? 0) > failedAt ? ok : null;
}

/** A different opId wrote after the marker: the marker's intent was superseded. */
async function superseded(aksis: string[], targetId: string, opId: string, t: number, same?: (m: Marker) => boolean): Promise<boolean> {
  const rows = await auditRows(aksis, targetId);
  return rows.some(({ m }) => m.opId !== opId && (m.t ?? 0) >= t && (!same || same(m)));
}

async function auditFailure(actorEmail: string, aksi: string, targetId: string, opId: string) {
  try {
    await logAudit({ actorEmail, action: `${aksi}_gagal`, targetId, after: { opId, t: Date.now() }, opId });
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

/** Names by RECORD_ID() filter, at most NAME_CHUNK ids per request (no full table scan). */
async function namesOf(teamIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(teamIds.filter((i) => REC_ID.test(i)))];
  for (let i = 0; i < want.length; i += NAME_CHUNK) {
    const chunk = want.slice(i, i + NAME_CHUNK);
    const rows = await listRecords(T.teamUmat, {
      fields: [F.teamUmat.namaLengkap],
      filterByFormula: `OR(${chunk.map((id) => `RECORD_ID()="${id}"`).join(",")})`,
    });
    for (const r of rows) out.set(r.id, str(r.fields[F.teamUmat.namaLengkap]).trim());
  }
  return out;
}

export async function getAbsenSheet(actor: Session, eventKepId: string, subEventId: string): Promise<AbsenSheet> {
  const ctx = await scope(actor, eventKepId);
  const sub = await ownSubEvent(ctx, subEventId);
  const rows = await pesertaRows(actor, ctx);
  const nama = await namesOf(rows.flatMap((r) => ids(r.fields[P.teamUmat]).slice(0, 1)));
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

type CoreOpts = { checkMarker: boolean; verify: boolean; aksi?: "absen_set" | "absen_set_ulang" };

async function setHadirCore(actor: Session, ctx: Ctx, subEventId: string, pendaftaranId: string, hadir: boolean, opId: string, o: CoreOpts): Promise<{ hadir: boolean; changed: boolean }> {
  if (typeof pendaftaranId !== "string" || !REC_ID.test(pendaftaranId)) throw new HttpError(404);
  return serial(pendaftaranId, async () => {
    const rec = ownPeserta(ctx, await fetch404(T.pendaftaranEvents, pendaftaranId));
    if (isMundur(rec)) throw new HttpError(409, "Peserta sudah mengundurkan diri");
    let cur = ids(rec.fields[P.pertemuanHadir]);
    const has = cur.includes(subEventId);
    let aksi = o.aksi ?? "absen_set";
    if (o.checkMarker) {
      const mk = await findMarker("absen_set", pendaftaranId, opId);
      if (mk) {
        if (mk.kepId !== ctx.eventKepId || mk.subEventId !== subEventId || mk.hadir !== hadir) throw CONFLICT();
        if (has === hadir) return { hadir: has, changed: false };
        // Marker says done but the state differs: re-apply unless a newer opId changed this pertemuan since.
        if (await superseded(["absen_set", "absen_set_ulang"], pendaftaranId, opId, mk.t ?? 0, (m) => m.subEventId === subEventId))
          return { hadir: has, changed: false };
        aksi = "absen_set_ulang";
      }
    }
    if (has === hadir && aksi === (o.aksi ?? "absen_set")) return { hadir: has, changed: false };
    await logAudit({
      actorEmail: actor.email,
      action: aksi,
      targetId: pendaftaranId,
      before: { subEventId, hadir: has },
      after: { opId, t: Date.now(), kepId: ctx.eventKepId, subEventId, hadir },
      opId,
    });
    const fail = async (e: unknown): Promise<never> => {
      await auditFailure(actor.email, aksi, pendaftaranId, opId);
      throw e;
    };
    const write = (links: string[]) => updateRecords(T.pendaftaranEvents, [{ id: pendaftaranId, fields: { [P.pertemuanHadir]: links } }]);
    const readLinks = async () => ids((await getRecord(T.pendaftaranEvents, pendaftaranId)).fields[P.pertemuanHadir]);
    try {
      if (!o.verify) {
        await write(nextLinks(cur, subEventId, hadir));
        return { hadir, changed: true };
      }
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        await write(nextLinks(cur, subEventId, hadir));
        cur = await readLinks();
        ok = cur.includes(subEventId) === hadir;
      }
      if (!ok) return await fail(new HttpError(503, "Absensi belum tersimpan. Coba lagi."));
      // Second verify after a short delay: catches a link array clobbered by another instance's write.
      await sleep(Number(process.env.ABSEN_RECHECK_MS ?? 400) || 0);
      cur = await readLinks();
      if (cur.includes(subEventId) !== hadir) {
        await write(nextLinks(cur, subEventId, hadir));
        cur = await readLinks();
        if (cur.includes(subEventId) !== hadir) return await fail(new HttpError(503, "Absensi belum tersimpan. Coba lagi."));
      }
      return { hadir: cur.includes(subEventId), changed: true };
    } catch (e) {
      if (e instanceof HttpError && e.status === 503) throw e;
      return fail(e);
    }
  });
}

export async function setHadir(actor: Session, eventKepId: string, subEventId: string, pendaftaranId: string, hadir: boolean, opId: string): Promise<{ hadir: boolean }> {
  const ctx = await scope(actor, eventKepId);
  checkOp(opId);
  if (typeof hadir !== "boolean") throw new HttpError(422, "Nilai hadir tidak valid");
  await ownSubEvent(ctx, subEventId);
  const r = await setHadirCore(actor, ctx, subEventId, pendaftaranId, hadir, opId, { checkMarker: true, verify: true });
  return { hadir: r.hadir };
}

/**
 * Marks active (non-mundur) peserta present, one by one, at most MAX_SEMUA per call and within a time budget.
 * `remaining` > 0: call again with the same opId (the run resumes value-based). Finishes with ONE re-list that
 * re-applies links that did not stick.
 */
export async function setSemuaHadir(actor: Session, eventKepId: string, subEventId: string, opId: string): Promise<{ updated: number; remaining: number }> {
  const ctx = await scope(actor, eventKepId);
  checkOp(opId);
  await ownSubEvent(ctx, subEventId);
  const earlier = await findMarker("absen_semua", subEventId, opId);
  if (earlier) {
    if (earlier.kepId !== eventKepId) throw CONFLICT();
    if (earlier.remaining === 0 && typeof earlier.updated === "number") return { updated: earlier.updated, remaining: 0 };
  }
  const base = typeof earlier?.updated === "number" ? earlier.updated : 0;
  const todo = (await pesertaRows(actor, ctx)).filter((r) => !isMundur(r) && !ids(r.fields[P.pertemuanHadir]).includes(subEventId));
  const budget = Number(process.env.ABSEN_SEMUA_BUDGET_MS ?? 45_000);
  const start = Date.now();
  const done: string[] = [];
  let updated = 0;
  for (const r of todo) {
    if (done.length >= MAX_SEMUA || (done.length > 0 && Date.now() - start >= budget)) break;
    done.push(r.id);
    try {
      if ((await setHadirCore(actor, ctx, subEventId, r.id, true, `${opId}:${r.id}`, { checkMarker: false, verify: false })).changed) updated++;
    } catch (e) {
      // mundur between the list and the write: skip. Anything else stops the run (a retry resumes it).
      if (!(e instanceof HttpError && (e.status === 409 || e.status === 404))) throw e;
    }
  }
  // One re-list: re-apply (once) any link that was lost.
  if (done.length > 0) {
    const have = new Map((await pesertaRows(actor, ctx)).map((r) => [r.id, r]));
    for (const id of done) {
      const r = have.get(id);
      if (!r || isMundur(r) || ids(r.fields[P.pertemuanHadir]).includes(subEventId)) continue;
      try {
        await setHadirCore(actor, ctx, subEventId, id, true, `${opId}:${id}`, { checkMarker: false, verify: false, aksi: "absen_set_ulang" });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
      }
    }
  }
  const remaining = todo.length - done.length;
  const total = base + updated;
  try {
    await logAudit({ actorEmail: actor.email, action: "absen_semua", targetId: subEventId, after: { opId, t: Date.now(), kepId: eventKepId, subEventId, updated: total, remaining }, opId });
  } catch {
    /* the per-peserta rows already exist; a replay is value-based */
  }
  return { updated: total, remaining };
}

const KET_AKSI = ["peserta_mundur", "mundur_batal", "hasil_tetap"] as const;
type KetAksi = (typeof KET_AKSI)[number];

async function setKeterangan(
  actor: Session,
  eventKepId: string,
  pendaftaranId: string,
  opId: string,
  aksi: KetAksi,
  nilai: string,
  o: { validate?: () => void; guard: (ctx: Ctx, rec: AtRecord, sebelum: string) => Promise<void> },
): Promise<void> {
  const ctx = await scope(actor, eventKepId);
  o.validate?.();
  checkOp(opId);
  if (typeof pendaftaranId !== "string" || !REC_ID.test(pendaftaranId)) throw new HttpError(404);
  await serial(pendaftaranId, async () => {
    const rec = ownPeserta(ctx, await fetch404(T.pendaftaranEvents, pendaftaranId));
    const sebelum = norm(rec.fields[P.keterangan]);
    let action: string = aksi;
    const mk = await findMarker(aksi, pendaftaranId, opId);
    if (mk) {
      if (mk.kepId !== eventKepId || mk.keterangan !== nilai) throw CONFLICT();
      if (sebelum === nilai) return;
      if (await superseded(KET_AKSI.flatMap((a) => [a, `${a}_ulang`]), pendaftaranId, opId, mk.t ?? 0)) return;
      action = `${aksi}_ulang`;
    } else if (sebelum === nilai) return;
    await o.guard(ctx, rec, sebelum);
    await logAudit({
      actorEmail: actor.email,
      action,
      targetId: pendaftaranId,
      before: { keterangan: auditKet(sebelum) },
      after: { opId, t: Date.now(), kepId: eventKepId, keterangan: nilai },
      opId,
    });
    try {
      await updateRecords(T.pendaftaranEvents, [{ id: pendaftaranId, fields: { [P.keterangan]: nilai === "" ? null : nilai } }]);
      const back = norm((await getRecord(T.pendaftaranEvents, pendaftaranId)).fields[P.keterangan]);
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
  return setKeterangan(actor, eventKepId, pendaftaranId, opId, "peserta_mundur", MUNDUR, {
    guard: async (_c, _r, sebelum) => {
      if (sebelum === "LULUS" || sebelum === "TIDAK LULUS") throw new HttpError(409, "Hasil akhir sudah ditetapkan");
    },
  });
}

/** Undo "mengundurkan diri": clears Keterangan only when it is MENGUNDURKAN DIRI. */
export async function batalkanMundur(actor: Session, eventKepId: string, pendaftaranId: string, opId: string): Promise<void> {
  return setKeterangan(actor, eventKepId, pendaftaranId, opId, "mundur_batal", "", {
    guard: async (_c, _r, sebelum) => {
      if (sebelum !== MUNDUR) throw new HttpError(409, "Peserta tidak berstatus mengundurkan diri");
    },
  });
}

export async function tetapkanHasil(actor: Session, eventKepId: string, pendaftaranId: string, hasil: Hasil, opId: string): Promise<void> {
  return setKeterangan(actor, eventKepId, pendaftaranId, opId, "hasil_tetap", hasil, {
    validate: () => {
      if (hasil !== "LULUS" && hasil !== "TIDAK LULUS") throw new HttpError(422, "Hasil tidak valid");
    },
    guard: async (ctx, _rec, sebelum) => {
      if (sebelum === MUNDUR) throw new HttpError(409, "Peserta sudah mengundurkan diri");
      const subs = await listRecords(T.subEvent, { fields: [F.subEvent.acara, F.subEvent.tanggal] });
      const dates = subs.filter((s) => ids(s.fields[F.subEvent.acara]).some((e) => ctx.eventIds.includes(e))).map((s) => day(s.fields[F.subEvent.tanggal])).filter(Boolean);
      const last = dates.sort().at(-1);
      if (!last || todayWib() < last) throw new HttpError(409, "Hasil akhir baru bisa ditetapkan mulai tanggal pertemuan terakhir");
    },
  });
}
