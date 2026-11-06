import "server-only";
import { createHash } from "node:crypto";
import { hash, verify, type Algorithm } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const HIBP_TIMEOUT_MS = 5000;

// Argon2id, OWASP-recommended minimum profile (19 MiB, t=2, p=1).
// Argon2id is enum value 2; the const enum is unusable under isolatedModules.
const ARGON2_OPTIONS = { algorithm: 2 as Algorithm, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export class BreachCheckUnavailableError extends Error {
  constructor() {
    super("Pemeriksaan keamanan kata sandi sedang tidak tersedia. Silakan coba lagi.");
    this.name = "BreachCheckUnavailableError";
  }
}

/** NFKC so the same visible password typed on different input methods is identical. */
const normalize = (pw: string) => pw.normalize("NFKC");

export function hashPassword(pw: string): Promise<string> {
  return hash(normalize(pw), ARGON2_OPTIONS);
}

/** Never throws: a malformed hash or any failure is simply "not verified". */
export async function verifyPassword(storedHash: string, pw: string): Promise<boolean> {
  const n = normalize(pw);
  if (Array.from(n).length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await verify(storedHash, n);
  } catch {
    return false;
  }
}

export function validatePasswordPolicy(pw: string): { ok: boolean; reason?: string } {
  const len = Array.from(normalize(pw)).length;
  if (len < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Kata sandi minimal ${MIN_PASSWORD_LENGTH} karakter.` };
  }
  if (len > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: `Kata sandi maksimal ${MAX_PASSWORD_LENGTH} karakter.` };
  }
  return { ok: true };
}

/**
 * HIBP k-anonymity: only the first 5 hex chars of the SHA-1 leave the server.
 * If the service cannot be reached the check fails closed (throws), so callers
 * must reject the new password and ask the user to try again.
 */
export async function isBreachedPassword(pw: string): Promise<boolean> {
  const sha1 = createHash("sha1").update(normalize(pw)).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  let body: string;
  try {
    const res = await fetch(HIBP_RANGE_URL + prefix, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HIBP ${res.status}`);
    body = await res.text();
  } catch {
    throw new BreachCheckUnavailableError();
  }
  return body.split(/\r?\n/).some((line) => {
    const [s, count] = line.trim().split(":");
    // With Add-Padding, padded rows have count 0 and must not count as a match.
    return s === suffix && Number(count) > 0;
  });
}
