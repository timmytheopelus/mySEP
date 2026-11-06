import { LinkError, confirmPasswordReset } from "@/lib/accounts/manage";
import { clientIp, guardPost, json, serverError, tooMany } from "@/lib/http/auth-http";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const WINDOW_S = 15 * 60;
const INVALID = "Tautan tidak valid atau sudah kedaluwarsa.";

/** Sets the password from a reset or invite link. Does not log the user in. */
export async function POST(req: Request): Promise<Response> {
  const blocked = guardPost(req);
  if (blocked) return blocked;
  const ip = await rateLimit(limitKey("reset-confirm-ip", clientIp(req)), 20, WINDOW_S);
  if (!ip.ok) return tooMany(ip.retryAfter);

  let b: { token?: unknown; password?: unknown } = {};
  try {
    b = await req.json();
  } catch {
    /* handled below */
  }
  if (typeof b?.token !== "string" || typeof b?.password !== "string") return json({ error: INVALID }, 400);
  try {
    await confirmPasswordReset(b.token, b.password);
    return json({ ok: true });
  } catch (e) {
    if (e instanceof LinkError) {
      if (e.code === "invalid") return json({ error: INVALID }, 400);
      if (e.code === "breach_unavailable") return json({ error: e.message }, 503);
      return json({ error: e.message }, 422);
    }
    console.error("password reset confirm failed");
    return serverError();
  }
}
