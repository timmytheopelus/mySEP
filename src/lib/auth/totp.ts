import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generateSecret, verifySync } from "otplib";

const STEP_SECONDS = 30;
const IV_LEN = 12;
const TAG_LEN = 16;

export function generateTotpSecret(): string {
  return generateSecret();
}

/**
 * Accepts the current code and one step either side (+-30 s). Returns the
 * matched time step, or null. Pass the account's last used step: a code whose
 * step is <= lastUsedStep is rejected (RFC 6238 5.2 replay protection). The
 * caller must persist the returned step. Never throws.
 */
export function verifyTotp(secret: string, code: string, lastUsedStep?: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  try {
    const r = verifySync({
      secret,
      token: code,
      epochTolerance: STEP_SECONDS,
      ...(typeof lastUsedStep === "number" ? { afterTimeStep: lastUsedStep } : {}),
    });
    return r.valid && "timeStep" in r && typeof r.timeStep === "number" ? r.timeStep : null;
  } catch {
    return null;
  }
}

function key(): Buffer {
  const raw = process.env.MFA_ENC_KEY;
  // Strict: canonical base64 of exactly 32 bytes (43 chars + "="); no silent char dropping.
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new Error("MFA_ENC_KEY must be 32 bytes, base64-encoded");
  return Buffer.from(raw, "base64");
}

/** AES-256-GCM. Blob = base64(iv[12] | tag[16] | ciphertext). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key(), iv, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, IV_LEN), { authTagLength: TAG_LEN });
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString("utf8");
}
