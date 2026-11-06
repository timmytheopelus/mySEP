import { z } from "zod";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { getPewarta, updatePewartaProfile } from "@/lib/pewarta/profile";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Body = z.object({ linkYoutube: z.string().max(300).optional(), bioSingkat: z.string().max(20000).optional() }).strict();

export const GET = withAuth<{ id: string }>(
  async (_req, { session, params }) => {
    const res = json({ pewarta: await getPewarta(session, params.id) });
    res.headers.set("Cache-Control", "no-store");
    return res;
  },
  { roles: ["SEP", "PIC", "ADMIN"] },
);

/** SEP only (withAuth role + updatePewartaProfile re-check). */
export const PATCH = withAuth<{ id: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("pewarta-profil", session.accountId), 30, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const parsed = Body.safeParse(await readBody(req));
    if (!parsed.success) throw new HttpError(422, "Data profil tidak valid");
    await updatePewartaProfile(session, params.id, parsed.data);
    return json({ ok: true });
  },
  { roles: ["SEP"] },
);
