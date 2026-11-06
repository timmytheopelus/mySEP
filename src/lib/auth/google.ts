import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";
import {
  bindGoogleSub,
  getAccountByEmail,
  mfaRequired,
  type Account,
} from "@/lib/accounts/repo";
import { isLocked } from "@/lib/auth/lockout";
import { getCookie } from "@/lib/auth/session";
import { limitKey, rateLimit } from "@/lib/ratelimit";

/**
 * Google OpenID Connect, authorization code flow with PKCE (S256).
 * state + nonce + PKCE verifier live in ONE short-lived signed httpOnly cookie (see signFlowCookie), are
 * single use, and the ID token is verified against Google's JWKS (RS256 only). Only an existing, active
 * AkunKEP row may sign in; nothing is created and every failure is the same `{ ok: false }`.
 */
export type FlowCookies = { state: string; nonce: string; verifier: string };
export type GoogleLoginResult =
  | { ok: true; next: "session" | "mfa" | "mfa_enroll"; account: Account }
  | { ok: false };

export const FLOW_COOKIE = "__Host-kep_gflow";
export const FLOW_TTL_S = 10 * 60;
export const CALLBACK_PATH = "/api/auth/google/callback";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const AUD_FLOW = "kep-gflow";
const HTTP_TIMEOUT_MS = 5000;

const rand = () => randomBytes(32).toString("base64url");

function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const base = process.env.GOOGLE_REDIRECT_BASE;
  if (!clientId || !clientSecret || !base) throw new Error("Google SSO is not configured");
  const u = new URL(base);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("GOOGLE_REDIRECT_BASE must be https");
  return { clientId, clientSecret, origin: u.origin, redirectUri: u.origin + CALLBACK_PATH };
}

/** Fixed, configured origin for every redirect the Google routes make (never derived from the request). */
export const appOrigin = () => config().origin;

export function buildGoogleAuthUrl(): { url: string; cookies: FlowCookies } {
  const { clientId, redirectUri } = config();
  const cookies: FlowCookies = { state: rand(), nonce: rand(), verifier: rand() };
  const u = new URL(AUTH_ENDPOINT);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid email",
    state: cookies.state,
    nonce: cookies.nonce,
    code_challenge: createHash("sha256").update(cookies.verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url: u.toString(), cookies };
}

function flowKey(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (>= 32 characters)");
  return new TextEncoder().encode(s);
}

/** Packs state/nonce/verifier into one HS256-signed token for the httpOnly cookie. */
export async function signFlowCookie(c: FlowCookies): Promise<string> {
  return new SignJWT({ s: c.state, n: c.nonce, v: c.verifier })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("kep")
    .setAudience(AUD_FLOW)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + FLOW_TTL_S)
    .sign(flowKey());
}

export async function readFlowCookie(cookieHeader: string): Promise<FlowCookies | null> {
  const token = getCookie(cookieHeader ?? "", FLOW_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, flowKey(), {
      algorithms: ["HS256"],
      issuer: "kep",
      audience: AUD_FLOW,
      requiredClaims: ["exp", "iat"],
    });
    const { s, n, v } = payload;
    if (typeof s !== "string" || typeof n !== "string" || typeof v !== "string") return null;
    return { state: s, nonce: n, verifier: v };
  } catch {
    return null;
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

// Created once: jose caches and rotates Google's keys (cooldown + max age) itself.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
const keys = () => (jwks ??= createRemoteJWKSet(new URL(JWKS_URI), { timeoutDuration: HTTP_TIMEOUT_MS }));

async function exchangeCode(code: string, verifier: string): Promise<string | null> {
  const { clientId, clientSecret, redirectUri } = config();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { id_token?: unknown };
  return typeof body.id_token === "string" && body.id_token ? body.id_token : null;
}

/** Google vouches for gmail.com/googlemail.com mailboxes, and for Workspace domains via the hd claim. */
function googleIsAuthoritative(email: string, hd: unknown): boolean {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return true;
  return typeof hd === "string" && hd !== "" && hd.toLowerCase() === domain;
}

/** Never throws: any error (network, config, Airtable) is a plain failure. */
export async function completeGoogleLogin(
  params: { code: string; state: string },
  cookies: FlowCookies,
): Promise<GoogleLoginResult> {
  const FAIL = { ok: false } as const;
  try {
    if (!params.code || !params.state || !safeEqual(params.state, cookies.state)) return FAIL;
    // Single use: the first attempt for a given state wins, replays fail closed.
    const claim = await rateLimit(limitKey("google-state", cookies.state), 1, FLOW_TTL_S + 60);
    if (!claim.ok) return FAIL;

    const idToken = await exchangeCode(params.code, cookies.verifier);
    if (!idToken) return FAIL;
    const { payload } = await jwtVerify(idToken, keys(), {
      algorithms: ["RS256"],
      issuer: ISSUERS,
      audience: config().clientId,
      requiredClaims: ["exp", "iat", "sub", "email", "nonce"],
    });
    if (typeof payload.nonce !== "string" || !safeEqual(payload.nonce, cookies.nonce)) return FAIL;
    // azp (when present) must be us; with a single aud it is optional, with several it is mandatory.
    if (payload.azp !== undefined && payload.azp !== config().clientId) return FAIL;
    if (Array.isArray(payload.aud) && payload.azp === undefined) return FAIL;
    if (payload.email_verified !== true) return FAIL;
    if (typeof payload.email !== "string" || typeof payload.sub !== "string" || !payload.sub) return FAIL;

    const acc = await getAccountByEmail(payload.email); // active only, case-insensitive
    if (!acc || isLocked(acc.lockedUntil, new Date())) return FAIL;

    if (acc.googleSub === null) {
      // Trust on first use only where Google is authoritative for the address. Linking for other
      // addresses must come from an already authenticated session (Task 8), never from this flow.
      if (!googleIsAuthoritative(payload.email, payload.hd)) return FAIL;
      const stored = await bindGoogleSub(acc.id, payload.sub, acc.email);
      if (stored === null || !safeEqual(stored, payload.sub)) return FAIL; // lost a concurrent bind
      acc.googleSub = payload.sub;
    } else if (!safeEqual(acc.googleSub, payload.sub)) {
      return FAIL;
    }

    const next = acc.mfaSecretEnc ? "mfa" : mfaRequired(acc.role) ? "mfa_enroll" : "session";
    return { ok: true, next, account: acc };
  } catch {
    return FAIL;
  }
}
