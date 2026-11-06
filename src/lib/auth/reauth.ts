import "server-only";
import { recordFailure, saveTotpStep, type Account } from "@/lib/accounts/repo";
import { isLocked, nextFailureState } from "@/lib/auth/lockout";
import { verifyPassword } from "@/lib/auth/password";
import { decryptSecret, verifyTotp } from "@/lib/auth/totp";
import { runInBackground } from "@/lib/background";
import { HttpError } from "@/lib/http/errors";
import { limitKey, rateLimit } from "@/lib/ratelimit";

const WINDOW_S = 15 * 60;

/**
 * Fresh proof of the second factor for a sensitive action by an already logged-in user.
 * Accounts with an authenticator (always SEP/PIC) need a current TOTP code, never just the password;
 * an Admin without MFA proves the password. Wrong answers count toward the shared lockout and a limiter.
 */
export async function reauthenticate(acc: Account, input: { code?: unknown; password?: unknown }): Promise<boolean> {
  if (isLocked(acc.lockedUntil, new Date())) return false;
  const lim = await rateLimit(limitKey("reauth", acc.id), 5, WINDOW_S);
  if (!lim.ok) throw new HttpError(429);

  let ok = false;
  if (acc.mfaSecretEnc) {
    if (typeof input.code === "string") {
      const step = verifyTotp(decryptSecret(acc.mfaSecretEnc), input.code, acc.lastTotpStep);
      if (step !== null) {
        await saveTotpStep(acc.id, step);
        ok = true;
      }
    }
  } else if (typeof input.password === "string" && acc.passwordHash) {
    ok = await verifyPassword(acc.passwordHash, input.password);
  }
  if (!ok) {
    const next = nextFailureState({ failed: acc.failed, lockedUntil: acc.lockedUntil }, new Date());
    runInBackground(() => recordFailure(acc.id, next));
  }
  return ok;
}
