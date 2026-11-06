import { requestPasswordReset } from "@/lib/accounts/manage";
import { clientIp, guardPost, json, tooMany } from "@/lib/http/auth-http";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const WINDOW_S = 15 * 60;
// Identical for every outcome: registered or not, valid body or not, mail sent or suppressed.
const SAME = () => json({ ok: true, message: "Jika email terdaftar, tautan pengaturan ulang password telah dikirim." });

export async function POST(req: Request): Promise<Response> {
  const blocked = guardPost(req);
  if (blocked) return blocked;
  const ip = await rateLimit(limitKey("reset-ip", clientIp(req)), 10, WINDOW_S);
  if (!ip.ok) return tooMany(ip.retryAfter);

  let email = "";
  try {
    const b = await req.json();
    if (typeof b?.email === "string") email = b.email;
  } catch {
    /* same answer */
  }
  try {
    await requestPasswordReset(email);
  } catch {
    console.error("password reset request failed"); // still the same response: no oracle
  }
  return SAME();
}
