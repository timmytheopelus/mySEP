import { isLocked, nextFailureState } from "@/lib/auth/lockout";
import { decryptSecret, encryptSecret, generateTotpSecret, verifyTotp } from "@/lib/auth/totp";
import { getAccountById, recordFailure, recordSuccess, saveMfaEnrollment } from "@/lib/accounts/repo";
import {
  PREAUTH_COOKIE,
  PREAUTH_TTL_S,
  SESSION_COOKIE,
  SESSION_TTL_S,
  clearCookieString,
  cookieString,
  issuePreauth,
  issueSession,
  readPreauth,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const ISSUER = "KEP Keuskupan Bandung";

/**
 * Two calls, both authenticated by the short-lived pre-auth cookie set after a correct password:
 *  1. `{}`          -> generates a pending secret (kept encrypted in the cookie, not in Airtable).
 *  2. `{ code }`    -> verifies the first code, stores the secret, completes login.
 * Wrong codes count against the account's lockout, same as the login MFA step.
 */
export async function POST(req: Request): Promise<Response> {
  const pre = await readPreauth(req.headers.get("cookie") ?? "");
  if (!pre) return Response.json({ error: "Sesi pendaftaran MFA tidak valid. Silakan masuk kembali." }, { status: 401 });
  const acc = await getAccountById(pre.accountId);
  if (!acc) return Response.json({ error: "Sesi pendaftaran MFA tidak valid. Silakan masuk kembali." }, { status: 401 });
  if (acc.mfaSecretEnc) return Response.json({ error: "MFA sudah terdaftar" }, { status: 409 });
  const now = new Date();
  if (isLocked(acc.lockedUntil, now)) {
    return Response.json({ error: "Terlalu banyak percobaan. Coba lagi nanti." }, { status: 429 });
  }

  let body: { code?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = step 1 */
  }
  const code = body?.code;

  if (code === undefined) {
    const secret = generateTotpSecret();
    const uri =
      `otpauth://totp/${encodeURIComponent(`${ISSUER}:${acc.email}`)}` +
      `?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}`;
    const res = Response.json({ secret, otpauthUri: uri });
    res.headers.append("Set-Cookie", cookieString(PREAUTH_COOKIE, await issuePreauth(acc.id, encryptSecret(secret)), PREAUTH_TTL_S));
    return res;
  }

  if (typeof code !== "string" || !pre.pendingSecretEnc) {
    return Response.json({ error: "Permintaan tidak valid" }, { status: 400 });
  }
  const secret = decryptSecret(pre.pendingSecretEnc);
  const step = verifyTotp(secret, code, null);
  if (step === null) {
    await recordFailure(acc.id, nextFailureState({ failed: acc.failed, lockedUntil: acc.lockedUntil }, now));
    return Response.json({ error: "Kode salah" }, { status: 400 });
  }
  await saveMfaEnrollment(acc.id, encryptSecret(secret), step);
  await recordSuccess(acc.id, now, step);
  const token = await issueSession({ accountId: acc.id, email: acc.email, role: acc.role, parokiId: acc.parokiId });
  const res = Response.json({ ok: true, role: acc.role });
  res.headers.append("Set-Cookie", cookieString(SESSION_COOKIE, token, SESSION_TTL_S));
  res.headers.append("Set-Cookie", clearCookieString(PREAUTH_COOKIE));
  return res;
}
