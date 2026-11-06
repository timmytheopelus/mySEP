import "server-only";
import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { getAccountById, mfaRequired, type Role } from "@/lib/accounts/repo";

export type { Role };
export type Session = { accountId: string; email: string; role: Role; parokiId: string | null };
export type Amr = "pwd" | "otp" | "google";

export const SESSION_COOKIE = "__Host-kep_session";
export const PREAUTH_COOKIE = "kep_preauth";
/** Pre-auth cookie is only sent to the enrollment route. */
export const PREAUTH_PATH = "/api/auth/mfa/enroll";
/** Google SSO: TOTP step for accounts that already have a secret. Own cookie, own path, own purpose. */
export const PREAUTH_VERIFY_COOKIE = "kep_preauth_verify";
export const PREAUTH_VERIFY_PATH = "/api/auth/google/mfa";
export const SESSION_TTL_S = 15 * 60;
export const SESSION_MAX_S = 8 * 3600;
export const PREAUTH_TTL_S = 5 * 60;
export const ACCOUNT_CACHE_MS = 60_000;

const ISSUER = "kep";
const AUD_SESSION = "kep-session";
const AUD_PREAUTH = "kep-preauth";
const PURPOSE_ENROLL = "mfa_enroll";
const PURPOSE_VERIFY = "mfa_verify";
export type PreauthPurpose = "mfa_enroll" | "mfa_verify";
export type PreauthVia = "pwd" | "google";
const REQUIRED = ["exp", "iat", "sub"];

function secretKey(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (>= 32 characters)");
  return new TextEncoder().encode(s);
}

const nowS = () => Math.floor(Date.now() / 1000);

/** JWT HS256, 15 minutes, never beyond `startedAt` + 8 hours. `amr` records how the user authenticated. */
export async function issueSession(
  session: Session,
  opts: { startedAt?: number; amr?: Amr[] } = {},
): Promise<string> {
  const iat = nowS();
  const startedAt = opts.startedAt ?? iat;
  const exp = Math.min(iat + SESSION_TTL_S, startedAt + SESSION_MAX_S);
  return new SignJWT({ email: session.email, role: session.role, pid: session.parokiId, sa: startedAt, amr: opts.amr ?? ["pwd"] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
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

async function resolve(cookieHeader: string): Promise<{ session: Session; startedAt: number; amr: Amr[] } | null> {
  const token = getCookie(cookieHeader ?? "", SESSION_COOKIE);
  if (!token) return null;
  let sub: string, startedAt: number, amr: Amr[];
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUD_SESSION,
      requiredClaims: REQUIRED,
    });
    if (!payload.sub || typeof payload.sa !== "number" || !Array.isArray(payload.amr)) return null;
    sub = payload.sub;
    startedAt = payload.sa;
    amr = payload.amr.filter((x): x is Amr => x === "pwd" || x === "otp" || x === "google");
  } catch {
    return null;
  }
  const session = await liveSession(sub);
  if (!session) return null;
  // SEP/PIC need a second factor: a token minted without OTP is void if the live role requires it.
  if (mfaRequired(session.role) && !amr.includes("otp")) return null;
  return { session, startedAt, amr };
}

export async function readSession(cookieHeader: string): Promise<Session | null> {
  return (await resolve(cookieHeader))?.session ?? null;
}

/** Valid session plus a fresh token (sliding expiry, capped at 8 h from first login). */
export async function renewSession(cookieHeader: string): Promise<{ session: Session; token: string } | null> {
  const r = await resolve(cookieHeader);
  return r ? { session: r.session, token: await issueSession(r.session, { startedAt: r.startedAt, amr: r.amr }) } : null;
}

/** Binds a pre-auth token to the credential it was issued for: a password change voids it. */
export const credentialFingerprint = (passwordHash: string) =>
  createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);

/**
 * Short-lived proof that the password step passed. Absolute lifetime: `origIat` + 5 min, so re-issuing
 * (to attach a pending secret) never extends the window. `purpose` limits it to MFA enrollment.
 */
export async function issuePreauth(args: {
  accountId: string;
  /** Credential material the token is bound to: the password hash, or `google:<sub>` for SSO. */
  passwordHash: string;
  purpose?: PreauthPurpose;
  via?: PreauthVia;
  pendingSecretEnc?: string;
  origIat?: number;
}): Promise<string> {
  const iat = nowS();
  const oi = args.origIat ?? iat;
  return new SignJWT({
    purpose: args.purpose ?? PURPOSE_ENROLL,
    via: args.via ?? "pwd",
    pf: credentialFingerprint(args.passwordHash),
    oi,
    ...(args.pendingSecretEnc ? { ps: args.pendingSecretEnc } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(args.accountId)
    .setAudience(AUD_PREAUTH)
    .setIssuedAt(iat)
    .setExpirationTime(Math.min(iat + PREAUTH_TTL_S, oi + PREAUTH_TTL_S))
    .sign(secretKey());
}

export type Preauth = {
  accountId: string;
  fingerprint: string;
  origIat: number;
  pendingSecretEnc: string | null;
  via: PreauthVia;
};

export async function readPreauth(cookieHeader: string, purpose: PreauthPurpose = PURPOSE_ENROLL): Promise<Preauth | null> {
  const cookieName = purpose === PURPOSE_VERIFY ? PREAUTH_VERIFY_COOKIE : PREAUTH_COOKIE;
  const token = getCookie(cookieHeader ?? "", cookieName);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUD_PREAUTH,
      requiredClaims: REQUIRED,
    });
    if (!payload.sub || payload.purpose !== purpose || typeof payload.pf !== "string" || typeof payload.oi !== "number") {
      return null;
    }
    return {
      accountId: payload.sub,
      fingerprint: payload.pf,
      origIat: payload.oi,
      pendingSecretEnc: typeof payload.ps === "string" ? payload.ps : null,
      via: payload.via === "google" ? "google" : "pwd",
    };
  } catch {
    return null;
  }
}

export function cookieString(name: string, value: string, maxAgeS: number, path = "/"): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;
}
export const sessionCookie = (token: string) => cookieString(SESSION_COOKIE, token, SESSION_TTL_S);
export const clearSessionCookie = () => cookieString(SESSION_COOKIE, "", 0);
export const preauthCookie = (token: string, maxAgeS: number) => cookieString(PREAUTH_COOKIE, token, maxAgeS, PREAUTH_PATH);
export const clearPreauthCookie = () => cookieString(PREAUTH_COOKIE, "", 0, PREAUTH_PATH);
export const preauthVerifyCookie = (token: string, maxAgeS: number) =>
  cookieString(PREAUTH_VERIFY_COOKIE, token, maxAgeS, PREAUTH_VERIFY_PATH);
export const clearPreauthVerifyCookie = () => cookieString(PREAUTH_VERIFY_COOKIE, "", 0, PREAUTH_VERIFY_PATH);
