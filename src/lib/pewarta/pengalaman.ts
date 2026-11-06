import "server-only";
import { listRecords } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Number of KEP pertemuan each pewarta is assigned to (one per pertemuan), from the SubEvent links.
 * Aggregates only: no KEP, parish or participant data leaves this function.
 */
export async function pengalamanPewarta(session: Session): Promise<Map<string, number>> {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  const [subs, keps] = await Promise.all([
    listRecords(T.subEvent, { fields: [F.subEvent.acara, F.subEvent.tanggal, F.subEvent.pengajar] }),
    listRecords(T.eventKep, { fields: [F.eventKep.events, F.eventKep.statusPersetujuan] }),
  ]);
  // Only approved KEPs and meetings already held (WIB date): a proposal or a future assignment is not experience yet.
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const kepEvents = new Set(keps.filter((k) => k.fields[F.eventKep.statusPersetujuan] === "Disetujui").flatMap((k) => ids(k.fields[F.eventKep.events])));
  const out = new Map<string, number>();
  for (const s of subs) {
    if (!ids(s.fields[F.subEvent.acara]).some((e) => kepEvents.has(e))) continue; // SubEvent also serves non-KEP events
    const tgl = typeof s.fields[F.subEvent.tanggal] === "string" ? (s.fields[F.subEvent.tanggal] as string).slice(0, 10) : "";
    if (!tgl || tgl > today) continue;
    for (const p of new Set(ids(s.fields[F.subEvent.pengajar]))) out.set(p, (out.get(p) ?? 0) + 1);
  }
  return out;
}
