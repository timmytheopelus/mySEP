import { withAuth } from "@/lib/auth/guard";
import { json, tooMany } from "@/lib/http/auth-http";
import { getAbsenSheet } from "@/lib/kep/absensi";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** Attendance sheet of one pertemuan; PIC/ADMIN of the owning paroki only. */
export const GET = withAuth<{ id: string; subEventId: string }>(
  async (_req, { session, params }) => {
    const lim = await rateLimit(limitKey("absen-sheet", session.accountId), 240, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    return json(await getAbsenSheet(session, params.id, params.subEventId));
  },
  { roles: ["PIC", "ADMIN"] },
);
