import { z } from "zod";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { listKepQueue } from "@/lib/kep/approval";
import { KepPartialError, createKep } from "@/lib/kep/create";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    parokiId: z.string().regex(/^rec[A-Za-z0-9]{10,}$/).optional(),
    angkatan: z.number().int().min(1).max(9999),
    tanggalMulai: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

/** SEP queue of KEPs waiting for (or rejected in) a decision. */
export const GET = withAuth(async (_req, { session }) => json({ antrean: await listKepQueue(session) }), { roles: ["SEP"] });

/** PIC creates a KEP for the own paroki. Unknown keys (penyelenggara, status...) are refused outright. */
export const POST = withAuth(
  async (req, { session }) => {
    const lim = await rateLimit(limitKey("kep-create", session.accountId), 5, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const parsed = Body.safeParse(await readBody(req));
    if (!parsed.success) throw new HttpError(422, "Data KEP tidak valid");
    try {
      const r = await createKep(session, parsed.data);
      return json(r, 201);
    } catch (e) {
      if (e instanceof KepPartialError)
        return json({ error: "Pembuatan KEP belum selesai. Kirim ulang permintaan yang sama untuk melanjutkan.", sudahTerbuat: e.created }, 500);
      throw e;
    }
  },
  { roles: ["PIC"] },
);
