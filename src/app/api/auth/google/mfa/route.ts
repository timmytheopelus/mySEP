import { isLocked, nextFailureState } from "@/lib/auth/lockout";
import { decryptSecret, verifyTotp } from "@/lib/auth/totp";
import { getAccountById, recordFailure, recordSuccess } from "@/lib/accounts/repo";
import {
  clearPreauthVerifyCookie,
  credentialFingerprint,
  issueSession,
  readPreauth,
  sessionCookie,
} from "@/lib/auth/session";
import { runInBackground } from "@/lib/background";
import { clientIp, guardPost, json, serverError, tooMany, withCookies } from "@/lib/http/auth-http";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const WINDOW_S = 15 * 60;
const INVALID = "Sesi tidak valid. Silakan masuk kembali.";

/**
 * Second step after Google for accounts that already have a TOTP secret. Authenticated only by the
 * short-lived `mfa_verify` pre-auth cookie issued by the Google callback. Same limits and lockout as
 * password login; the session is minted here, with amr google+otp.
 */
export async function POST(req: Request): Promise<Response> {
  const blocked = guardPost(req);
  if (blocked) return blocked;
  const ipLimit = await rateLimit(limitKey("gmfa-ip", clientIp(req)), 60, WINDOW_S);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfter);

  const pre = await readPreauth(req.headers.get("cookie") ?? "", "mfa_verify");
  if (!pre || pre.via !== "google") return json({ error: INVALID }, 401);
  const acctLimit = await rateLimit(limitKey("gmfa-acct", pre.accountId), 10, WINDOW_S);
  if (!acctLimit.ok) return tooMany(acctLimit.retryAfter);
  const mfaLimit = await rateLimit(limitKey("gmfa-code", pre.accountId), 5, WINDOW_S);
  if (!mfaLimit.ok) return tooMany(mfaLimit.retryAfter);

  let body: { code?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Permintaan tidak valid" }, 400);
  }
  if (typeof body?.code !== "string") return json({ error: "Permintaan tidak valid" }, 400);

  const acc = await getAccountById(pre.accountId);
  if (!acc || !acc.googleSub || !acc.mfaSecretEnc || credentialFingerprint(`google:${acc.googleSub}`) !== pre.fingerprint) {
    return json({ error: INVALID }, 401);
  }
  const now = new Date();
  if (isLocked(acc.lockedUntil, now)) return json({ error: INVALID }, 401);

  let secret: string;
  try {
    secret = decryptSecret(acc.mfaSecretEnc);
  } catch {
    console.error("mfa secret decryption failed");
    return serverError();
  }
  const step = verifyTotp(secret, body.code, acc.lastTotpStep);
  if (step === null) {
    const next = nextFailureState({ failed: acc.failed, lockedUntil: acc.lockedUntil }, now);
    runInBackground(() => recordFailure(acc.id, next));
    return json({ error: "Kode salah" }, 401);
  }

  await recordSuccess(acc.id, now, step);
  const token = await issueSession(
    { accountId: acc.id, email: acc.email, role: acc.role, parokiId: acc.parokiId },
    { amr: ["google", "otp"] },
  );
  return withCookies(json({ ok: true, role: acc.role }), [sessionCookie(token), clearPreauthVerifyCookie()]);
}
