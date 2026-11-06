import "server-only";
import { getRecord, listRecords, updateRecords } from "@/lib/airtable/client";
import { F, T, pickAllowedForRole } from "@/lib/airtable/schema";
import { assertKepInScope, assertSubEventInScope, requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { logAudit } from "@/lib/audit/log";
import { HttpError } from "@/lib/http/errors";
import { invalidateKepCache } from "@/lib/kep/readModel";
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
 * PIC of the owning paroki only (Admin Paroki 403, SEP 403, other parish 404). Pewarta may be proposed only while the KEP
 * is Diajukan: after approval the PIC could otherwise toggle an assignment to unlock a pewarta's phone number.
 */
async function scope(actor: Session, eventKepId: string) {
  requireRole(actor, ["PIC"]);
  const { eventKep } = await assertKepInScope(actor, eventKepId);
  return { eventIds: ids(eventKep.fields[F.eventKep.events]), terkunci: str(eventKep.fields[F.eventKep.statusPersetujuan]) !== "Diajukan" };
}

export type JadwalItem = { id: string; urutan: number; agenda: string; tanggal: string; pengajarIds: string[] };
export type Jadwal = { pertemuan: JadwalItem[]; opsi: { id: string; nama: string }[]; terkunci: boolean };

/** Pertemuan of the KEP with their current pewarta, plus the active pewarta that can be assigned (names only). */
export async function getJadwal(actor: Session, eventKepId: string): Promise<Jadwal> {
  const { eventIds, terkunci } = await scope(actor, eventKepId);
  const [subs, pewarta] = await Promise.all([
    listRecords(T.subEvent, { fields: [F.subEvent.acara, F.subEvent.agenda, F.subEvent.tanggal, F.subEvent.urutan, F.subEvent.pengajar] }),
    listPewarta(actor),
  ]);
  const pertemuan = subs
    .filter((s) => ids(s.fields[F.subEvent.acara]).some((e) => eventIds.includes(e)))
    .map((s) => ({
      id: s.id,
      urutan: Number(s.fields[F.subEvent.urutan]) || 0,
      agenda: str(s.fields[F.subEvent.agenda]),
      tanggal: day(s.fields[F.subEvent.tanggal]),
      pengajarIds: ids(s.fields[F.subEvent.pengajar]),
    }))
    .sort((a, b) => a.tanggal.localeCompare(b.tanggal) || a.urutan - b.urutan || a.id.localeCompare(b.id));
  return { pertemuan, opsi: pewarta.map((p) => ({ id: p.id, nama: p.nama })), terkunci };
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
  const { eventIds, terkunci } = await scope(actor, eventKepId);
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
    after: { opId, t: Date.now(), kepId: eventKepId, ids: want },
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
