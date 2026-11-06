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
    listRecords(T.subEvent, { fields: [F.subEvent.acara, F.subEvent.pengajar] }),
    listRecords(T.eventKep, { fields: [F.eventKep.events] }),
  ]);
  const kepEvents = new Set(keps.flatMap((k) => ids(k.fields[F.eventKep.events])));
  const out = new Map<string, number>();
  for (const s of subs) {
    if (!ids(s.fields[F.subEvent.acara]).some((e) => kepEvents.has(e))) continue; // SubEvent also serves non-KEP events
    for (const p of new Set(ids(s.fields[F.subEvent.pengajar]))) out.set(p, (out.get(p) ?? 0) + 1);
  }
  return out;
}
