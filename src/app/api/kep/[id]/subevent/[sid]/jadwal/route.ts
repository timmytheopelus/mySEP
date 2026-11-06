import { z } from "zod";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { updateWaktu } from "@/lib/kep/jadwal";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    tanggal: z.string().max(10),
    jamMulai: z.string().max(5),
    jamSelesai: z.string().max(5),
    opId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();

/** Change tanggal / jam of one pertemuan (PIC of the owning paroki while Diajukan or Disetujui; SEP unless rejected; Admin: 403). */
export const POST = withAuth<{ id: string; sid: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("jadwal-waktu", session.accountId), 120, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const parsed = Body.safeParse(await readBody(req));
    if (!parsed.success) throw new HttpError(422, "Data jadwal tidak valid");
    const { opId, ...waktu } = parsed.data;
    return json(await updateWaktu(session, params.id, params.sid, waktu, opId));
  },
  { roles: ["PIC", "SEP"] },
);
