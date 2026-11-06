import { z } from "zod";
import { withAuth } from "@/lib/auth/guard";
import { json, readBody, tooMany } from "@/lib/http/auth-http";
import { HttpError } from "@/lib/http/errors";
import { validationError } from "@/lib/http/registration-http";
import { WalkInInput } from "@/lib/kep/registration";
import { tambahWalkIn } from "@/lib/kep/walkin";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const Op = z.object({ opId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });

/**
 * Walk-in on the Absen screen (spec 8b.8): register name + WhatsApp (+ optional email) and mark hadir for this pertemuan.
 * PIC and Admin Paroki of the owning paroki. Online only (never queued by the client).
 */
export const POST = withAuth<{ id: string; subEventId: string }>(
  async (req, { session, params }) => {
    // Shares the budget of the manual registration route (both create people).
    const lim = await rateLimit(limitKey("peserta-manual", session.accountId), 60, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const body = await readBody(req);
    const op = Op.safeParse(body);
    if (!op.success) throw new HttpError(422, "opId tidak valid");
    const parsed = WalkInInput.safeParse(body);
    if (!parsed.success) return validationError(parsed.error);
    const r = await tambahWalkIn(session, params.id, params.subEventId, parsed.data, op.data.opId);
    return json(r, r.status === "registered" ? 201 : 200);
  },
  { roles: ["PIC", "ADMIN"] },
);
