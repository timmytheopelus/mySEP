import { buildGoogleAuthUrl, FLOW_COOKIE, FLOW_TTL_S, signFlowCookie } from "@/lib/auth/google";
import { cookieString } from "@/lib/auth/session";
import { clientIp, serverError, tooMany, withCookies } from "@/lib/http/auth-http";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const lim = await rateLimit(limitKey("google-start-ip", clientIp(req)), 30, 15 * 60);
  if (!lim.ok) return tooMany(lim.retryAfter);
  try {
    const { url, cookies } = buildGoogleAuthUrl();
    const res = new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
    // SameSite=Lax: the cookie must come back on Google's top-level GET redirect to the callback.
    return withCookies(res, [cookieString(FLOW_COOKIE, await signFlowCookie(cookies), FLOW_TTL_S)]);
  } catch {
    console.error("google sso start failed");
    return serverError();
  }
}

