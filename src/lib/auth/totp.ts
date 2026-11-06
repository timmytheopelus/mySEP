import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generateSecret, verifySync } from "otplib";

const STEP_SECONDS = 30;
const IV_LEN = 12;
const TAG_LEN = 16;

export function generateTotpSecret(): string {
  return generateSecret();
}

/** Accepts the current code and one step either side (±30 s). Never throws. */
export function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    return verifySync({ secret, token: code, epochTolerance: STEP_SECONDS }).valid;
  } catch {
    return false;
  }
}

function key(): Buffer {
  const raw = process.env.MFA_ENC_KEY;
  const k = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (k.length !== 32) throw new Error("MFA_ENC_KEY must be 32 bytes, base64-encoded");
  return k;
}

/** AES-256-GCM. Blob = base64(iv[12] | tag[16] | ciphertext). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, IV_LEN));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString("utf8");
}
