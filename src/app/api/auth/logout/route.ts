import { clearPreauthCookie, clearSessionCookie } from "@/lib/auth/session";
import { guardPost, json, withCookies } from "@/lib/http/auth-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const blocked = guardPost(req);
  if (blocked) return blocked;
  return withCookies(json({ ok: true }), [clearSessionCookie(), clearPreauthCookie()]);
}
