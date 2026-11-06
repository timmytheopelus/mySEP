import { z } from "zod";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { mundurkanPeserta } from "@/lib/kep/absensi";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Body = z.object({ opId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).strict();

export const POST = withAuth<{ id: string; pid: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("peserta-mundur", session.accountId), 60, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const parsed = Body.safeParse(await readBody(req));
    if (!parsed.success) throw new HttpError(422, "Data tidak valid");
    await mundurkanPeserta(session, params.id, params.pid, parsed.data.opId);
    return json({ ok: true });
  },
  { roles: ["PIC", "ADMIN"] },
);
