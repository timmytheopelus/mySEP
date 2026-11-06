import { z } from "zod";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { setHadir } from "@/lib/kep/absensi";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Body = z
  .object({ pendaftaranId: z.string().regex(/^rec[A-Za-z0-9]{10,}$/), hadir: z.boolean(), opId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) })
  .strict();

export const POST = withAuth<{ id: string; subEventId: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("absen-set", session.accountId), 600, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const parsed = Body.safeParse(await readBody(req));
    if (!parsed.success) throw new HttpError(422, "Data absensi tidak valid");
    const b = parsed.data;
    return json(await setHadir(session, params.id, params.subEventId, b.pendaftaranId, b.hadir, b.opId));
  },
  { roles: ["PIC", "ADMIN"] },
);
