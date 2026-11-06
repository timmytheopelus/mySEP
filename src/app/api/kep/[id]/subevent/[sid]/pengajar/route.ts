import { z } from "zod";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { assignPengajar } from "@/lib/kep/jadwal";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    pengajarIds: z.array(z.string().regex(/^rec[A-Za-z0-9]{10,}$/)).max(10),
    opId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();

/** Replace the pewarta of one pertemuan (PIC of the owning paroki; Diajukan only). */
export const POST = withAuth<{ id: string; sid: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("pengajar-set", session.accountId), 120, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const parsed = Body.safeParse(await readBody(req));
    if (!parsed.success) throw new HttpError(422, "Data penugasan tidak valid");
    return json(await assignPengajar(session, params.id, params.sid, parsed.data.pengajarIds, parsed.data.opId));
  },
  { roles: ["PIC"] },
);
