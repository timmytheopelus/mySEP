import { withAuth } from "@/lib/auth/guard";
import { logAudit } from "@/lib/audit/log";
import { json, tooMany } from "@/lib/http/auth-http";
import { importTarget, parseUpload } from "@/lib/kep/importHttp";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** Dry run: parses and validates the upload and writes nothing but one audit row. No row content is echoed back. */
export const POST = withAuth<{ id: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("peserta-import-preview", session.accountId), 30, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    await importTarget(session, params.id);
    const { sha256, parsed } = await parseUpload(req);
    try {
      await logAudit({ actorEmail: session.email, action: "import_preview", targetId: params.id, after: { sha256, valid: parsed.rows.length, galat: parsed.errors.length } });
    } catch {
      /* a preview writes nothing else; a missing audit row is acceptable */
    }
    return json({ sha256, valid: parsed.rows.length, errors: parsed.errors });
  },
  { roles: ["PIC"], multipart: true },
);
