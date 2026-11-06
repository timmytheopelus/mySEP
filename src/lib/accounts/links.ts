import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { credentialFingerprint } from "@/lib/auth/session";

/**
 * One-time emailed links (invite 72 h, reset 30 min). Signed JWT with a random jti, bound to the account's
 * current password hash through a hash prefix (`pf`): once the password is set or changed the token no longer
 * matches, so it is single use WITHOUT any extra Airtable field. An invite for an account that has no
 * password yet is bound to the empty hash marker. The token travels only in the URL fragment and is never logged.
 */
export type LinkKind = "invite" | "reset";
export const LINK_TTL_S: Record<LinkKind, number> = { invite: 72 * 3600, reset: 30 * 60 };

const AUD = "kep-link";
const ISSUER = "kep";

function key(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (>= 32 characters)");
  // Derived key: a session or pre-auth key can never verify (or forge) a link token.
  return createHash("sha256").update("kep-link-v1|" + s).digest();
}

export async function signLinkToken(kind: LinkKind, accountId: string, passwordHash: string | null): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ k: kind, pf: credentialFingerprint(passwordHash ?? "") })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setSubject(accountId)
    .setJti(randomBytes(16).toString("base64url"))
    .setIssuedAt(iat)
    .setExpirationTime(iat + LINK_TTL_S[kind])
    .sign(key());
}

export type LinkClaims = { kind: LinkKind; accountId: string; fingerprint: string; jti: string; expiresAt: number };

/** Signature, issuer, audience, expiry and claim shape only; the caller still checks the live account. */
export async function verifyLinkToken(token: string): Promise<LinkClaims | null> {
  if (typeof token !== "string" || token.length > 2000) return null;
  try {
    const { payload } = await jwtVerify(token, key(), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUD,
      requiredClaims: ["exp", "iat", "sub", "jti"],
    });
    if ((payload.k !== "invite" && payload.k !== "reset") || typeof payload.pf !== "string" || !payload.sub || !payload.jti || !payload.exp) {
      return null;
    }
    return { kind: payload.k, accountId: payload.sub, fingerprint: payload.pf, jti: payload.jti, expiresAt: payload.exp };
  } catch {
    return null;
  }
}

export const linkUrl = (origin: string, token: string) => `${origin}/atur-password#token=${token}`;
