import { z } from "zod";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { setSemuaHadir } from "@/lib/kep/absensi";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ opId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).strict();

export const POST = withAuth<{ id: string; subEventId: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("absen-semua", session.accountId), 20, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const parsed = Body.safeParse(await readBody(req));
    if (!parsed.success) throw new HttpError(422, "Data absensi tidak valid");
    return json(await setSemuaHadir(session, params.id, params.subEventId, parsed.data.opId));
  },
  { roles: ["PIC", "ADMIN"] },
);
