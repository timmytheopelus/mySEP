import { clearPreauthCookie, clearSessionCookie, revokeSession } from "@/lib/auth/session";
import { guardPost, json, withCookies } from "@/lib/http/auth-http";

export const dynamic = "force-dynamic";

/** Clears the cookie and denylists the session id server-side, so a copied cookie is dead too. */
export async function POST(req: Request): Promise<Response> {
  const blocked = guardPost(req);
  if (blocked) return blocked;
  await revokeSession(req.headers.get("cookie") ?? "");
  return withCookies(json({ ok: true }), [clearSessionCookie(), clearPreauthCookie()]);
}
