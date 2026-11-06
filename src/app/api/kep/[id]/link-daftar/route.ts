import { withAuth } from "@/lib/auth/guard";
import { json, tooMany } from "@/lib/http/auth-http";
import { getLinkDaftar } from "@/lib/kep/link";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** Public registration URL for a Disetujui KEP of the caller's own paroki (PIC / Admin Paroki). */
export const GET = withAuth<{ id: string }>(
  async (_req, { session, params }) => {
    const lim = await rateLimit(limitKey("link-daftar", session.accountId), 60, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    return json(await getLinkDaftar(session, params.id));
  },
  { roles: ["PIC"] },
);
