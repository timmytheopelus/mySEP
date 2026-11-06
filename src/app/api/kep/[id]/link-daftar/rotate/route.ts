import { z } from "zod";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { rotateLinkDaftar } from "@/lib/kep/link";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Body = z.object({ opId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).strict();

/** Revokes every registration link issued so far for this KEP; the next GET issues a fresh one. */
export const POST = withAuth<{ id: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("link-rotasi", session.accountId), 10, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const parsed = Body.safeParse(await readBody(req));
    if (!parsed.success) throw new HttpError(422, "Data tidak valid");
    return json(await rotateLinkDaftar(session, params.id, parsed.data.opId));
  },
  { roles: ["PIC"] },
);
