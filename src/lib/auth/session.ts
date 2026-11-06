import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { getAccountById, type Role } from "@/lib/accounts/repo";

export type { Role };
export type Session = { accountId: string; email: string; role: Role; parokiId: string | null };

export const SESSION_COOKIE = "kep_session";
export const PREAUTH_COOKIE = "kep_preauth";
export const SESSION_TTL_S = 15 * 60;
export const SESSION_MAX_S = 8 * 3600;
export const PREAUTH_TTL_S = 5 * 60;
export const ACCOUNT_CACHE_MS = 60_000;

const AUD_SESSION = "kep-session";
const AUD_PREAUTH = "kep-preauth";

function secretKey(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (>= 32 characters)");
  return new TextEncoder().encode(s);
}

const nowS = () => Math.floor(Date.now() / 1000);

/** JWT HS256, 15 minutes, never beyond `startedAt` + 8 hours (sliding window with an absolute cap). */
export async function issueSession(session: Session, startedAt: number = nowS()): Promise<string> {
  const iat = nowS();
  const exp = Math.min(iat + SESSION_TTL_S, startedAt + SESSION_MAX_S);
  return new SignJWT({ email: session.email, role: session.role, pid: session.parokiId, sa: startedAt })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.accountId)
    .setAudience(AUD_SESSION)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey());
}

export function getCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Account liveness cache: deactivating an account revokes sessions within ACCOUNT_CACHE_MS.
type Live = { at: number; session: Session | null };
const live = new Map<string, Live>();
export function clearSessionCache(): void {
  live.clear();
}

async function liveSession(accountId: string): Promise<Session | null> {
  const hit = live.get(accountId);
  if (hit && Date.now() - hit.at < ACCOUNT_CACHE_MS) return hit.session;
  const acc = await getAccountById(accountId);
  // Role and paroki always come from the live account, not from the token.
  const session = acc ? { accountId: acc.id, email: acc.email, role: acc.role, parokiId: acc.parokiId } : null;
  live.set(accountId, { at: Date.now(), session });
  return session;
}

async function decode(token: string): Promise<{ accountId: string; startedAt: number } | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"], audience: AUD_SESSION });
    if (!payload.sub || typeof payload.sa !== "number") return null;
    return { accountId: payload.sub, startedAt: payload.sa };
  } catch {
    return null;
  }
}

export async function readSession(cookieHeader: string): Promise<Session | null> {
  const token = getCookie(cookieHeader ?? "", SESSION_COOKIE);
  if (!token) return null;
  const t = await decode(token);
  return t ? liveSession(t.accountId) : null;
}

/** Valid session plus a fresh token (sliding expiry, capped at 8 h from first login). */
export async function renewSession(cookieHeader: string): Promise<{ session: Session; token: string } | null> {
  const token = getCookie(cookieHeader ?? "", SESSION_COOKIE);
  if (!token) return null;
  const t = await decode(token);
  if (!t) return null;
  const session = await liveSession(t.accountId);
  return session ? { session, token: await issueSession(session, t.startedAt) } : null;
}

/** Short-lived proof that the password step passed; carries the pending MFA secret during enrollment. */
export async function issuePreauth(accountId: string, pendingSecretEnc?: string): Promise<string> {
  const iat = nowS();
  return new SignJWT(pendingSecretEnc ? { ps: pendingSecretEnc } : {})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(accountId)
    .setAudience(AUD_PREAUTH)
    .setIssuedAt(iat)
    .setExpirationTime(iat + PREAUTH_TTL_S)
    .sign(secretKey());
}

export async function readPreauth(cookieHeader: string): Promise<{ accountId: string; pendingSecretEnc: string | null } | null> {
  const token = getCookie(cookieHeader ?? "", PREAUTH_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"], audience: AUD_PREAUTH });
    if (!payload.sub) return null;
    return { accountId: payload.sub, pendingSecretEnc: typeof payload.ps === "string" ? payload.ps : null };
  } catch {
    return null;
  }
}

export function cookieString(name: string, value: string, maxAgeS: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearCookieString = (name: string) => cookieString(name, "", 0);
