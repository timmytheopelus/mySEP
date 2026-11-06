import { recordSuccess } from "@/lib/accounts/repo";
import {
  FLOW_COOKIE,
  appOrigin,
  completeGoogleLink,
  completeGoogleLogin,
  readFlowCookie,
  type FlowCookies,
} from "@/lib/auth/google";
import {
  PREAUTH_TTL_S,
  cookieString,
  invalidateAccount,
  issuePreauth,
  issueSession,
  preauthCookie,
  preauthVerifyCookie,
  readSessionMeta,
  sessionCookie,
} from "@/lib/auth/session";
import { clientIp, withCookies } from "@/lib/http/auth-http";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const clearFlow = () => cookieString(FLOW_COOKIE, "", 0);

/** Fixed destinations only; the origin comes from configuration, never from the request or a parameter. */
function redirect(path: string, cookies: string[]): Response {
  let origin: string;
  try {
    origin = appOrigin();
  } catch {
    return new Response("Terjadi kesalahan.", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  const res = new Response(null, { status: 302, headers: { Location: origin + path, "Cache-Control": "no-store" } });
  return withCookies(res, cookies);
}

// One uniform failure for everything: bad state, bad token, unknown/inactive/locked/mismatched account.
const failure = () => redirect("/login?error=google", [clearFlow()]);

/** "Hubungkan Google" from a logged-in session: never signs in; re-issues the cookie after the change. */
async function linkCallback(req: Request, params: { code: string; state: string }, flow: FlowCookies): Promise<Response> {
  const bad = () => redirect("/profil?google=gagal", [clearFlow()]);
  try {
    const meta = await readSessionMeta(req.headers.get("cookie") ?? "");
    if (!meta || meta.session.accountId !== flow.linkAccountId) return bad();
    const r = await completeGoogleLink(params, flow, meta.session.accountId);
    if (!r.ok) return bad();
    invalidateAccount(meta.session.accountId);
    // The Google binding is part of the session version: keep this user logged in.
    const token = await issueSession(meta.session, { startedAt: meta.startedAt, amr: meta.amr, jti: meta.jti });
    return redirect("/profil?google=ok", [clearFlow(), sessionCookie(token)]);
  } catch {
    console.error("google link callback failed");
    return bad();
  }
}

export async function GET(req: Request): Promise<Response> {
  const lim = await rateLimit(limitKey("google-cb-ip", clientIp(req)), 60, 15 * 60);
  if (!lim.ok) return failure();

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.has("error") || !code || !state) return failure();
  const flow = await readFlowCookie(req.headers.get("cookie") ?? "");
  if (!flow) return failure();

  if (flow.linkAccountId) return linkCallback(req, { code, state }, flow);

  const r = await completeGoogleLogin({ code, state }, flow);
  if (!r.ok) return failure();
  const acc = r.account;

  try {
    // Pre-auth tokens are bound to the Google sub (a changed binding voids them).
    const credential = `google:${acc.googleSub}`;
    if (r.next === "mfa_enroll") {
      const token = await issuePreauth({ accountId: acc.id, passwordHash: credential, via: "google" });
      return redirect("/login?step=enroll", [clearFlow(), preauthCookie(token, PREAUTH_TTL_S)]);
    }
    if (r.next === "mfa") {
      const token = await issuePreauth({ accountId: acc.id, passwordHash: credential, via: "google", purpose: "mfa_verify" });
      return redirect("/login?step=mfa", [clearFlow(), preauthVerifyCookie(token, PREAUTH_TTL_S)]);
    }
    await recordSuccess(acc.id, new Date(), null);
    const session = await issueSession(
      { accountId: acc.id, email: acc.email, role: acc.role, parokiId: acc.parokiId },
      { amr: ["google"] },
    );
    return redirect("/kep", [clearFlow(), sessionCookie(session)]);
  } catch {
    console.error("google sso callback failed");
    return failure();
  }
}
