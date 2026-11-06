import "server-only";
import { F } from "@/lib/airtable/schema";
import { requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { logAudit } from "@/lib/audit/log";
import { HttpError } from "@/lib/http/errors";
import { OP_ID, listPertemuan, setHadir } from "@/lib/kep/absensi";
import { RegistrationClosedError, RegistrationInputError, registerWalkIn } from "@/lib/kep/registration";
import { assertKepInScope } from "@/lib/auth/guard";

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export type WalkInResult = { status: "registered" | "already_registered"; pendaftaranId: string; hadir: true };

/**
 * Spec 8b.8 "Peserta datang langsung": register a person (name + WhatsApp, email optional) for this KEP through the
 * normal registration path (manual registration: dedupe by WhatsApp/email, an existing TeamUmat row is NEVER written
 * to) and mark them hadir for the current pertemuan. PIC and Admin Paroki of the owning paroki; the KEP must be
 * Disetujui. Online only. Idempotent per opId: a retry finds the registration (already_registered) and the hadir mark.
 * Audit rows carry ids only. Warm cache: pertemuan list (cached) + dedupe lookup + create + audit + the tap (4).
 */
export async function tambahWalkIn(actor: Session, eventKepId: string, subEventId: string, raw: unknown, opId: string): Promise<WalkInResult> {
  requireRole(actor, ["PIC", "ADMIN"]);
  if (typeof opId !== "string" || !OP_ID.test(opId)) throw new HttpError(422, "opId tidak valid");
  // Scope (404 other parish), Disetujui (409) and "this pertemuan belongs to this KEP" (404) BEFORE anything is created.
  const { items } = await listPertemuan(actor, eventKepId);
  if (!items.some((p) => p.id === subEventId)) throw new HttpError(404);
  const { eventKep } = await assertKepInScope(actor, eventKepId);
  const eventId = ids(eventKep.fields[F.eventKep.events])[0];
  if (!eventId) throw new HttpError(409, "KEP belum memiliki acara");

  let reg;
  try {
    // Audit first (ids only, no personal data), abort when it cannot be written.
    await logAudit({ actorEmail: actor.email, action: "peserta_walkin_daftar", targetId: eventKepId, after: { subEventId, opId, role: actor.role } });
    reg = await registerWalkIn(eventId, raw, { actorEmail: actor.email });
  } catch (e) {
    if (e instanceof RegistrationClosedError) throw new HttpError(409, "Pendaftaran belum dibuka atau sudah ditutup untuk KEP ini.");
    if (e instanceof RegistrationInputError) throw new HttpError(422, e.message);
    throw e;
  }
  // The tap: same checks and audit trail as a normal attendance tap (mundur -> 409; panitia row -> 404).
  try {
    await setHadir(actor, eventKepId, subEventId, reg.pendaftaranId, true, opId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new HttpError(409, "Orang ini terdaftar sebagai panitia, bukan peserta.");
    throw e;
  }
  return { status: reg.status, pendaftaranId: reg.pendaftaranId, hadir: true };
}
