import { isLocked, nextFailureState } from "@/lib/auth/lockout";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { decryptSecret, verifyTotp } from "@/lib/auth/totp";
import {
  getAccountByEmail,
  mfaRequired,
  normalizeEmail,
  recordFailure,
  recordSuccess,
  type Account,
} from "@/lib/accounts/repo";
import {
  PREAUTH_TTL_S,
  issuePreauth,
  issueSession,
  preauthCookie,
  clearPreauthCookie,
  sessionCookie,
} from "@/lib/auth/session";
import { runInBackground } from "@/lib/background";
import { clientIp, guardPost, json, serverError, tooMany, withCookies } from "@/lib/http/auth-http";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const GENERIC = "Email atau password salah";
const WINDOW_S = 15 * 60;
const IP_LIMIT = 60;
const ACCOUNT_LIMIT = 10;
const MFA_LIMIT = 5;

const fail = () => json({ error: GENERIC }, 401);

// Hashed once per process so unknown/locked/inactive accounts cost the same as real ones.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword("dummy-password-for-timing-equalisation"));

/**
 * The Airtable failure counter is written after the response (never awaited here), so a known account
 * with a wrong password responds as fast as an unknown one. The counter is durable but best-effort
 * (read-modify-write); the atomic limiter in front of this route is the enforcing control.
 */
function failAttempt(acc: Account, now: Date): Response {
  const next = nextFailureState({ failed: acc.failed, lockedUntil: acc.lockedUntil }, now);
  runInBackground(() => recordFailure(acc.id, next));
  return fail();
}

export async function POST(req: Request): Promise<Response> {
  const blocked = guardPost(req);
  if (blocked) return blocked;
  const ipLimit = await rateLimit(limitKey("login-ip", clientIp(req)), IP_LIMIT, WINDOW_S);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfter);

  let body: { email?: unknown; password?: unknown; totp?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Permintaan tidak valid" }, 400);
  }
  const { email, password, totp } = body ?? {};
  if (typeof email !== "string" || typeof password !== "string" || (totp !== undefined && typeof totp !== "string")) {
    return json({ error: "Permintaan tidak valid" }, 400);
  }

  const e = normalizeEmail(email);
  const acctLimit = await rateLimit(limitKey("login-acct", e), ACCOUNT_LIMIT, WINDOW_S);
  if (!acctLimit.ok) return tooMany(acctLimit.retryAfter);
  if (totp) {
    const mfaLimit = await rateLimit(limitKey("login-mfa", e), MFA_LIMIT, WINDOW_S);
    if (!mfaLimit.ok) return tooMany(mfaLimit.retryAfter);
  }

  const now = new Date();
  const acc = await getAccountByEmail(email);

  // Locked is checked BEFORE the password is verified; every non-attempt path still burns one hash.
  if (!acc || !acc.passwordHash || isLocked(acc.lockedUntil, now)) {
    await verifyPassword(await getDummyHash(), password);
    return fail();
  }
  if (!(await verifyPassword(acc.passwordHash, password))) return failAttempt(acc, now);

  let step: number | null = null;
  if (acc.mfaSecretEnc) {
    if (!totp) return json({ next: "mfa" });
    let secret: string;
    try {
      secret = decryptSecret(acc.mfaSecretEnc);
    } catch {
      // Misconfiguration (bad/rotated MFA_ENC_KEY), not a user failure: no lockout counting, no detail.
      console.error("mfa secret decryption failed");
      return serverError();
    }
    step = verifyTotp(secret, totp, acc.lastTotpStep);
    // Step 0 is a valid step: compare against null, never test truthiness.
    if (step === null) return failAttempt(acc, now);
  } else if (mfaRequired(acc.role)) {
    const res = json({ next: "mfa_enroll" });
    const token = await issuePreauth({ accountId: acc.id, passwordHash: acc.passwordHash });
    return withCookies(res, [preauthCookie(token, PREAUTH_TTL_S)]);
  }

  await recordSuccess(acc.id, now, step);
  const token = await issueSession(
    { accountId: acc.id, email: acc.email, role: acc.role, parokiId: acc.parokiId },
    { amr: step !== null ? ["pwd", "otp"] : ["pwd"] },
  );
  return withCookies(json({ ok: true, role: acc.role }), [sessionCookie(token), clearPreauthCookie()]);
}
