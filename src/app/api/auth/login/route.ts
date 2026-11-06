import { isLocked, nextFailureState } from "@/lib/auth/lockout";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { decryptSecret, verifyTotp } from "@/lib/auth/totp";
import {
  getAccountByEmail,
  mfaRequired,
  recordFailure,
  recordSuccess,
  type Account,
} from "@/lib/accounts/repo";
import {
  PREAUTH_COOKIE,
  PREAUTH_TTL_S,
  SESSION_COOKIE,
  SESSION_TTL_S,
  clearCookieString,
  cookieString,
  issuePreauth,
  issueSession,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const GENERIC = "Email atau password salah";

const fail = () => Response.json({ error: GENERIC }, { status: 401 });

// Hashed once per process so unknown/locked/inactive accounts cost the same as real ones.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword("dummy-password-for-timing-equalisation"));

async function failAttempt(acc: Account, now: Date): Promise<Response> {
  await recordFailure(acc.id, nextFailureState({ failed: acc.failed, lockedUntil: acc.lockedUntil }, now));
  return fail();
}

export async function POST(req: Request): Promise<Response> {
  let body: { email?: unknown; password?: unknown; totp?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Permintaan tidak valid" }, { status: 400 });
  }
  const { email, password, totp } = body ?? {};
  if (typeof email !== "string" || typeof password !== "string" || (totp !== undefined && typeof totp !== "string")) {
    return Response.json({ error: "Permintaan tidak valid" }, { status: 400 });
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
    if (!totp) return Response.json({ next: "mfa" });
    let secret: string;
    try {
      secret = decryptSecret(acc.mfaSecretEnc);
    } catch {
      return failAttempt(acc, now);
    }
    step = verifyTotp(secret, totp, acc.lastTotpStep);
    // Step 0 is a valid step: compare against null, never test truthiness.
    if (step === null) return failAttempt(acc, now);
  } else if (mfaRequired(acc.role)) {
    const res = Response.json({ next: "mfa_enroll" });
    res.headers.append("Set-Cookie", cookieString(PREAUTH_COOKIE, await issuePreauth(acc.id), PREAUTH_TTL_S));
    return res;
  }

  await recordSuccess(acc.id, now, step);
  const token = await issueSession({ accountId: acc.id, email: acc.email, role: acc.role, parokiId: acc.parokiId });
  const res = Response.json({ ok: true, role: acc.role });
  res.headers.append("Set-Cookie", cookieString(SESSION_COOKIE, token, SESSION_TTL_S));
  res.headers.append("Set-Cookie", clearCookieString(PREAUTH_COOKIE));
  return res;
}
