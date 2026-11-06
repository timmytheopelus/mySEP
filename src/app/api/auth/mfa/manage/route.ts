import { decryptSecret, encryptSecret, generateTotpSecret, verifyTotp } from "@/lib/auth/totp";
import { getAccountById, recordFailure, saveMfaEnrollment, writeAudit, type Account } from "@/lib/accounts/repo";
import { isLocked, nextFailureState } from "@/lib/auth/lockout";
import { enrollmentPayload } from "@/lib/auth/enrollment";
import { withAuth } from "@/lib/auth/guard";
import { invalidateAccount, issueSession, readSessionMeta, sessionCookie } from "@/lib/auth/session";
import { runInBackground } from "@/lib/background";
import { HttpError } from "@/lib/http/errors";
import { json, readBody, tooMany, withCookies } from "@/lib/http/auth-http";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const WINDOW_S = 15 * 60;
const PENDING_TTL_S = 10 * 60;

/** Encrypted (AES-GCM) pending enrollment handed to the client: account-bound and short-lived. */
const sealPending = (accountId: string, secret: string) =>
  encryptSecret(JSON.stringify({ a: accountId, s: secret, e: Math.floor(Date.now() / 1000) + PENDING_TTL_S }));
function openPending(blob: unknown, accountId: string): string {
  try {
    const p = JSON.parse(decryptSecret(String(blob))) as { a?: string; s?: string; e?: number };
    if (p.a === accountId && typeof p.s === "string" && typeof p.e === "number" && p.e > Date.now() / 1000) return p.s;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "Sesi pendaftaran habis. Mulai lagi.");
}

/** Counts a wrong code toward the shared login lockout (same counters as the login routes). */
function countFailure(acc: Account): void {
  const next = nextFailureState({ failed: acc.failed, lockedUntil: acc.lockedUntil }, new Date());
  runInBackground(() => recordFailure(acc.id, next));
}

/**
 * MFA enrollment/replacement for a LOGGED-IN user.
 *  step 1  { currentCode? }             -> { secret, otpauthUri, qr, pending }
 *  step 2  { pending, code, currentCode? } -> stores the secret, re-issues the session
 * When a secret already exists, the CURRENT code is required at both steps; a stolen session alone
 * cannot replace the authenticator.
 */
export const POST = withAuth(
  async (req, { session }) => {
    const b = await readBody(req);
    const acc = await getAccountById(session.accountId);
    if (!acc) throw new HttpError(401);
    if (isLocked(acc.lockedUntil, new Date())) throw new HttpError(429);

    const enrolled = acc.mfaSecretEnc !== null;
    if (enrolled) {
      const lim = await rateLimit(limitKey("mfa-manage-cur", acc.id), 5, WINDOW_S);
      if (!lim.ok) return tooMany(lim.retryAfter);
      if (typeof b.currentCode !== "string") throw new HttpError(403, "Masukkan kode autentikator saat ini");
      let current: string;
      try {
        current = decryptSecret(acc.mfaSecretEnc!);
      } catch {
        throw new HttpError(403);
      }
      if (verifyTotp(current, b.currentCode, acc.lastTotpStep) === null) {
        countFailure(acc);
        throw new HttpError(403, "Kode autentikator saat ini salah");
      }
    }

    if (b.pending === undefined) {
      const secret = generateTotpSecret();
      return json({ ...(await enrollmentPayload(acc.email, secret)), pending: sealPending(acc.id, secret) });
    }

    const secret = openPending(b.pending, acc.id);
    if (typeof b.code !== "string") throw new HttpError(400);
    const step = verifyTotp(secret, b.code, null);
    if (step === null) {
      countFailure(acc);
      throw new HttpError(400, "Kode salah");
    }

    const meta = await readSessionMeta(req.headers.get("cookie") ?? "");
    if (!meta) throw new HttpError(401);
    await writeAudit({ aksi: enrolled ? "mfa_ganti" : "mfa_daftar", pelaku: acc.email, targetId: acc.id });
    await saveMfaEnrollment(acc.id, encryptSecret(secret), step);
    invalidateAccount(acc.id);
    // The secret is part of the session version: re-issue so the user's own change does not log them out.
    const token = await issueSession(session, {
      startedAt: meta.startedAt,
      amr: Array.from(new Set([...meta.amr, "otp" as const])),
    });
    return withCookies(json({ ok: true }), [sessionCookie(token)]);
  },
  { roles: ["SEP", "PIC", "ADMIN"] },
);
