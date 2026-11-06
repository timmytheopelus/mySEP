import "server-only";
import { cachedList } from "@/lib/airtable/cache";
import { F, T } from "@/lib/airtable/schema";
import { assertEventsInScope, assertKepInScope, listPesertaInScope, requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { logAudit } from "@/lib/audit/log";
import { namesOf } from "@/lib/kep/absensi";
import { limitKey, sharedGetJson, sharedSetJson } from "@/lib/ratelimit";

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const P = F.pendaftaranEvents;
const INACTIVE = new Set(["batal", "dobel daftar"]);
export const KESEHATAN_AUDIT_WINDOW_S = 600;
const MAX_AUDIT_IDS = 300;

export type KesehatanItem = {
  pendaftaranId: string;
  nama: string;
  /** Withdrawn (MENGUNDURKAN DIRI): still listed, shown dimmed. */
  mundur: boolean;
  riwayatPenyakit: string;
  riwayatAlergi: string;
  obatRutin: string;
  kontakDarurat: string;
};
export type Kesehatan = { kepId: string; nama: string; items: KesehatanItem[]; jumlahPeserta: number };

/**
 * Spec §4 (data kesehatan "hanya terlihat oleh PIC dan Admin paroki yang bersangkutan"): the peserta of ONE KEP who
 * recorded a health note or an emergency contact. PIC / Admin Paroki of the owning paroki only (SEP 403, other parish
 * 404). Reads only the allowlisted Pendaftaran Events fields through the filtered, shared read (one KEP's rows, fresh);
 * the register itself is the only place these fields are read. The view is audited ("data_kesehatan_dilihat", record
 * ids only) BEFORE anything is returned, at most once per 10 minutes per actor and KEP (a failed audit aborts).
 */
export async function getKesehatan(actor: Session, eventKepId: string): Promise<Kesehatan> {
  requireRole(actor, ["PIC", "ADMIN"]);
  const { eventKep } = await assertKepInScope(actor, eventKepId); // 404 for foreign / unknown / malformed
  // The rows belong to the EVENT: if another parish's KEP shares it, its peserta must not be disclosed here.
  await assertEventsInScope(actor, ids(eventKep.fields[F.eventKep.events]));
  const rows = (
    await listPesertaInScope(actor, [P.teamUmat, P.statusPendaftaran, P.kategoriKepesertaan, P.keterangan, P.riwayatPenyakit, P.riwayatAlergi, P.obatRutin, P.kontakDarurat], eventKepId, { fresh: true })
  ).filter((r) => !INACTIVE.has(str(r.fields[P.statusPendaftaran]).toLowerCase()) && str(r.fields[P.kategoriKepesertaan]).toLowerCase() !== "panitia");
  const withData = rows.filter((r) => [P.riwayatPenyakit, P.riwayatAlergi, P.obatRutin, P.kontakDarurat].some((f) => str(r.fields[f]) !== ""));

  // Audit before disclosure. Marker in the shared store (Upstash / memory); when the store is unavailable every view is audited.
  const seenKey = limitKey("kesehatan-dilihat", actor.accountId, eventKepId);
  if ((await sharedGetJson<number>(seenKey)) === null) {
    await logAudit({
      actorEmail: actor.email,
      action: "data_kesehatan_dilihat",
      targetId: eventKepId,
      after: { role: actor.role, pendaftaranIds: withData.slice(0, MAX_AUDIT_IDS).map((r) => r.id).sort() },
    });
    await sharedSetJson(seenKey, 1, KESEHATAN_AUDIT_WINDOW_S);
  }

  const eventId = ids(eventKep.fields[F.eventKep.events])[0];
  let nama = "";
  if (eventId) {
    try {
      const ev = await cachedList(T.events, [F.events.namaAcara], `RECORD_ID()="${eventId}"`, { ttlMs: 10 * 60_000 });
      nama = str(ev.find((e) => e.id === eventId)?.fields[F.events.namaAcara]);
    } catch {
      /* the title is cosmetic */
    }
  }
  const names = await namesOf(withData.flatMap((r) => ids(r.fields[P.teamUmat]).slice(0, 1)));
  const items = withData
    .map((r) => ({
      pendaftaranId: r.id,
      nama: names.get(ids(r.fields[P.teamUmat])[0] ?? "") || "(tanpa nama)",
      mundur: str(r.fields[P.keterangan]).toUpperCase() === "MENGUNDURKAN DIRI",
      riwayatPenyakit: str(r.fields[P.riwayatPenyakit]),
      riwayatAlergi: str(r.fields[P.riwayatAlergi]),
      obatRutin: str(r.fields[P.obatRutin]),
      kontakDarurat: str(r.fields[P.kontakDarurat]),
    }))
    .sort((a, b) => a.nama.localeCompare(b.nama, "id", { sensitivity: "base" }) || a.pendaftaranId.localeCompare(b.pendaftaranId));
  return { kepId: eventKepId, nama: nama || "KEP", items, jumlahPeserta: rows.length };
}
