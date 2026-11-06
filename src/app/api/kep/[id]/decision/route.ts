import { z } from "zod";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { decideKep } from "@/lib/kep/approval";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Body = z.object({ keputusan: z.enum(["Disetujui", "Ditolak"]), catatan: z.string().max(2000).optional() }).strict();

/** SEP only (withAuth role + decideKep re-check). */
export const POST = withAuth<{ id: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("kep-decide", session.accountId), 30, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const parsed = Body.safeParse(await readBody(req));
    if (!parsed.success) throw new HttpError(422, "Keputusan tidak valid");
    await decideKep(session, params.id, parsed.data.keputusan, parsed.data.catatan ?? "");
    return json({ ok: true });
  },
  { roles: ["SEP"] },
);
