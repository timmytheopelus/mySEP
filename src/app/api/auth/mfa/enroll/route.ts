import { isLocked, nextFailureState } from "@/lib/auth/lockout";
import { decryptSecret, encryptSecret, generateTotpSecret, verifyTotp } from "@/lib/auth/totp";
import { getAccountById, recordSuccess, recordFailure, saveMfaEnrollment } from "@/lib/accounts/repo";
import {
  PREAUTH_TTL_S,
  clearPreauthCookie,
  credentialFingerprint,
  issuePreauth,
  issueSession,
  preauthCookie,
  readPreauth,
  sessionCookie,
} from "@/lib/auth/session";
import { enrollmentPayload } from "@/lib/auth/enrollment";
import { runInBackground } from "@/lib/background";
import { clientIp, guardPost, json, serverError, tooMany, withCookies } from "@/lib/http/auth-http";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const WINDOW_S = 15 * 60;
const INVALID = "Sesi pendaftaran MFA tidak valid. Silakan masuk kembali.";

/**
 * Two calls, both authenticated by the short-lived pre-auth cookie set after a correct password:
 *  1. `{}`          -> generates a pending secret (kept encrypted in the cookie, not in Airtable).
 *  2. `{ code }`    -> verifies the first code, stores the secret, completes login.
 * The pre-auth token is bound to the account's current password hash and has a hard 5 minute
 * lifetime from first issue; step 1 never extends it. Wrong codes count against the limiter and lockout.
 */
export async function POST(req: Request): Promise<Response> {
  const blocked = guardPost(req);
  if (blocked) return blocked;
  const ipLimit = await rateLimit(limitKey("enroll-ip", clientIp(req)), 60, WINDOW_S);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfter);

  const pre = await readPreauth(req.headers.get("cookie") ?? "");
  if (!pre) return json({ error: INVALID }, 401);
  const acctLimit = await rateLimit(limitKey("enroll-acct", pre.accountId), 10, WINDOW_S);
  if (!acctLimit.ok) return tooMany(acctLimit.retryAfter);

  const acc = await getAccountById(pre.accountId);
  // Void when the account is gone or its password changed since the pre-auth token was issued.
  const credential = pre.via === "google" ? (acc?.googleSub ? `google:${acc.googleSub}` : null) : (acc?.passwordHash ?? null);
  if (!acc || !credential || credentialFingerprint(credential) !== pre.fingerprint) {
    return json({ error: INVALID }, 401);
  }
  if (acc.mfaSecretEnc) return json({ error: "MFA sudah terdaftar" }, 409);
  const now = new Date();
  if (isLocked(acc.lockedUntil, now)) {
    return tooMany(Math.max(1, Math.ceil((Date.parse(acc.lockedUntil!) - now.getTime()) / 1000)));
  }

  let body: { code?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = step 1 */
  }
  const code = body?.code;

  try {
    if (code === undefined) {
      const secret = generateTotpSecret();
      const token = await issuePreauth({
        accountId: acc.id,
        passwordHash: credential,
        via: pre.via,
        pendingSecretEnc: encryptSecret(secret),
        origIat: pre.origIat,
      });
      const remaining = Math.max(1, pre.origIat + PREAUTH_TTL_S - Math.floor(Date.now() / 1000));
      return withCookies(json(await enrollmentPayload(acc.email, secret)), [preauthCookie(token, remaining)]);
    }

    if (typeof code !== "string" || !pre.pendingSecretEnc) return json({ error: "Permintaan tidak valid" }, 400);
    const secret = decryptSecret(pre.pendingSecretEnc);
    const step = verifyTotp(secret, code, null);
    if (step === null) {
      const next = nextFailureState({ failed: acc.failed, lockedUntil: acc.lockedUntil }, now);
      runInBackground(() => recordFailure(acc.id, next));
      return json({ error: "Kode salah" }, 400);
    }

    // One-shot atomic claim, then a fresh re-read: two parallel completions cannot both write a secret.
    const claim = await rateLimit(limitKey("enroll-done", acc.id), 1, PREAUTH_TTL_S * 2);
    const fresh = await getAccountById(acc.id);
    if (!claim.ok || !fresh || fresh.mfaSecretEnc) return json({ error: "MFA sudah terdaftar" }, 409);

    await saveMfaEnrollment(acc.id, encryptSecret(secret), step);
    await recordSuccess(acc.id, now, step);
    const token = await issueSession(
      { accountId: acc.id, email: acc.email, role: acc.role, parokiId: acc.parokiId },
      { amr: [pre.via === "google" ? "google" : "pwd", "otp"] },
    );
    return withCookies(json({ ok: true, role: acc.role }), [sessionCookie(token), clearPreauthCookie()]);
  } catch {
    // e.g. bad/rotated MFA_ENC_KEY: not a user failure, no counting, no detail.
    console.error("mfa enrollment failed");
    return serverError();
  }
}
