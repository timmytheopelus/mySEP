import { clearPreauthCookie, clearSessionCookie, revokeSession } from "@/lib/auth/session";
import { guardPost, json, withCookies } from "@/lib/http/auth-http";

export const dynamic = "force-dynamic";

/**
 * Clears the cookie and denylists the session id server-side, so a copied cookie is dead too. If the shared
 * store does not confirm the denylist write, the cookie is still cleared, the failure is logged (no token) and
 * the response says so (serverRevoked: false).
 */
export async function POST(req: Request): Promise<Response> {
  const blocked = guardPost(req);
  if (blocked) return blocked;
  const r = await revokeSession(req.headers.get("cookie") ?? "");
  if (r === "failed") console.error("[logout] session denylist write failed: a copied cookie stays valid until it expires");
  return withCookies(json({ ok: true, serverRevoked: r !== "failed" }), [clearSessionCookie(), clearPreauthCookie()]);
}
