import { getAccountById } from "@/lib/accounts/repo";
import { FLOW_COOKIE, FLOW_TTL_S, buildGoogleAuthUrl, signFlowCookie } from "@/lib/auth/google";
import { withAuth } from "@/lib/auth/guard";
import { cookieString } from "@/lib/auth/session";
import { reauthenticate } from "@/lib/auth/reauth";
import { HttpError } from "@/lib/http/errors";
import { json, readBody, withCookies } from "@/lib/http/auth-http";

export const dynamic = "force-dynamic";

/**
 * "Hubungkan Google": a logged-in user links their Google identity. Requires fresh re-authentication
 * (TOTP code for accounts with MFA, password for an Admin without) and returns the Google URL to visit.
 * The flow cookie remembers which account started it; the callback checks the session still matches.
 */
export const POST = withAuth(
  async (req, { session }) => {
    const b = await readBody(req);
    const acc = await getAccountById(session.accountId);
    if (!acc) throw new HttpError(401);
    if (acc.googleSub) throw new HttpError(409, "Akun Google sudah terhubung. Minta SEP melepasnya terlebih dahulu.");
    if (!(await reauthenticate(acc, b))) throw new HttpError(403, "Verifikasi ulang gagal");
    const { url, cookies } = buildGoogleAuthUrl();
    const flow = await signFlowCookie({ ...cookies, linkAccountId: acc.id });
    return withCookies(json({ url }), [cookieString(FLOW_COOKIE, flow, FLOW_TTL_S)]);
  },
  { roles: ["SEP", "PIC", "ADMIN"] },
);
