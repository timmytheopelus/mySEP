import { withAuth, assertKepInScope } from "@/lib/auth/guard";
import { logAudit } from "@/lib/audit/log";
import { F } from "@/lib/airtable/schema";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { validationError } from "@/lib/http/registration-http";
import { PesertaInput, RegistrationClosedError, RegistrationInputError, registerPeserta, resolveOpenKep } from "@/lib/kep/registration";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Manual registration by PIC / Admin Paroki of the owning paroki (cross-parish: 404). Same dedupe, allowlist and
 * "KEP must be Disetujui" rules as the public form, no captcha (the caller is authenticated).
 */
export const POST = withAuth<{ id: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("peserta-manual", session.accountId), 60, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const { eventKep } = await assertKepInScope(session, params.id);
    const parsed = PesertaInput.safeParse(await readBody(req));
    if (!parsed.success) return validationError(parsed.error);
    const eventId = ids(eventKep.fields[F.eventKep.events])[0];
    if (!eventId) throw new HttpError(409, "KEP belum memiliki acara");
    try {
      await resolveOpenKep(eventId);
      // Audit first (no personal data), abort when it cannot be written.
      await logAudit({ actorEmail: session.email, action: "peserta_manual_daftar", targetId: params.id });
      const r = await registerPeserta(eventId, parsed.data, { actorEmail: session.email });
      try {
        await logAudit({ actorEmail: session.email, action: "peserta_manual_selesai", targetId: params.id, after: { status: r.status, pendaftaranId: r.pendaftaranId } });
      } catch {
        /* the "daftar" row above already exists */
      }
      return json(r, r.status === "registered" ? 201 : 200);
    } catch (e) {
      if (e instanceof RegistrationClosedError) return json({ error: "Pendaftaran belum dibuka: KEP belum disetujui SEP." }, 409);
      if (e instanceof RegistrationInputError) return json({ error: e.message }, 422);
      throw e;
    }
  },
  { roles: ["PIC", "ADMIN"] },
);
