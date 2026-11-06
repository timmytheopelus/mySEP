import { PREAUTH_COOKIE, SESSION_COOKIE, clearCookieString } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", clearCookieString(SESSION_COOKIE));
  res.headers.append("Set-Cookie", clearCookieString(PREAUTH_COOKIE));
  return res;
}
