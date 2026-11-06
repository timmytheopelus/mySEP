import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { generateSync } from "otplib";
import { SignJWT, decodeJwt, exportJWK, generateKeyPair, type JWK, type CryptoKey } from "jose";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import { buildGoogleAuthUrl, completeGoogleLogin, signFlowCookie, readFlowCookie } from "@/lib/auth/google";
import { GET as start } from "@/app/api/auth/google/start/route";
import { GET as callback } from "@/app/api/auth/google/callback/route";
import { POST as googleMfa } from "@/app/api/auth/google/mfa/route";
import { POST as enroll } from "@/app/api/auth/mfa/enroll/route";
import { clearSessionCache, readSession } from "@/lib/auth/session";
import { flushBackground } from "@/lib/background";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const A = F.akunKep;
const CLIENT_ID = "client-123.apps.googleusercontent.com";
const ISS = "https://accounts.google.com";
const SEP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const row = (id: string) => store[T.akunKep].find((r) => r.id === id)!;

let signKey: CryptoKey;
let jwks: { keys: JWK[] };
let otherKey: CryptoKey;
let fetchMock: ReturnType<typeof vi.fn>;
let tokenBodies: URLSearchParams[] = [];
let nextIdToken = "";

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  signKey = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
  otherKey = (await generateKeyPair("RS256")).privateKey;
});

type Claims = Record<string, unknown>;
async function mint(claims: Claims, opts: { key?: CryptoKey; alg?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email_verified: true, ...claims })
    .setProtectedHeader({ alg: (opts.alg ?? "RS256") as "RS256", kid: "k1" })
    .setIssuer((claims.iss as string) ?? ISS)
    .setAudience((claims.aud as string) ?? CLIENT_ID)
    .setSubject((claims.sub as string) ?? "g-sub-1")
    .setIssuedAt(now)
    .setExpirationTime((claims.exp as number) ?? now + 300)
    .sign(opts.key ?? signKey);
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "shh");
  vi.stubEnv("GOOGLE_REDIRECT_BASE", "https://kep.example.org");
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  tokenBodies = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return Response.json(jwks);
    if (url === "https://oauth2.googleapis.com/token") {
      tokenBodies.push(new URLSearchParams(String(init?.body)));
      return Response.json({ id_token: nextIdToken, access_token: "x" });
    }
    throw new Error("unexpected network call: " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Drives a full library-level login with a minted ID token. */
async function run(
  claims: Claims,
  o: { state?: string; mintOpts?: Parameters<typeof mint>[1]; useNonce?: string } = {},
) {
  const { cookies } = buildGoogleAuthUrl();
  nextIdToken = await mint({ nonce: o.useNonce ?? cookies.nonce, ...claims }, o.mintOpts);
  return completeGoogleLogin({ code: "auth-code", state: o.state ?? cookies.state }, cookies);
}

describe("authorization URL", () => {
  it("is authorization code + PKCE S256 with state, nonce and a fixed redirect URI", () => {
    const { url, cookies } = buildGoogleAuthUrl();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe("https://kep.example.org/api/auth/google/callback");
    expect(u.searchParams.get("scope")).toBe("openid email");
    expect(u.searchParams.get("state")).toBe(cookies.state);
    expect(u.searchParams.get("nonce")).toBe(cookies.nonce);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(createHash("sha256").update(cookies.verifier).digest("base64url"));
    expect(cookies.state).not.toBe(cookies.nonce);
    expect(cookies.state.length).toBeGreaterThanOrEqual(32);
  });

  it("refuses a non-https redirect base (except localhost) and missing config", () => {
    vi.stubEnv("GOOGLE_REDIRECT_BASE", "http://evil.example.org");
    expect(() => buildGoogleAuthUrl()).toThrow();
    vi.stubEnv("GOOGLE_REDIRECT_BASE", "http://localhost:3000");
    expect(() => buildGoogleAuthUrl()).not.toThrow();
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    expect(() => buildGoogleAuthUrl()).toThrow();
  });

  it("the flow cookie is signed, and tampering or foreign tokens are rejected", async () => {
    const { cookies } = buildGoogleAuthUrl();
    const signed = await signFlowCookie(cookies);
    expect(await readFlowCookie(`__Host-kep_gflow=${signed}`)).toEqual(cookies);
    expect(await readFlowCookie(`__Host-kep_gflow=${signed.slice(0, -2)}xx`)).toBeNull();
    expect(await readFlowCookie("")).toBeNull();
  });
});

describe("completeGoogleLogin", () => {
  const seedAdmin = () => seedAccount({ id: "recADMIN00000001", email: "budi@gmail.com", peran: "Admin Paroki" });

  it("sends the PKCE verifier and client secret to the token endpoint", async () => {
    await seedAdmin();
    const { url, cookies } = buildGoogleAuthUrl();
    nextIdToken = await mint({ nonce: cookies.nonce, email: "budi@gmail.com" });
    await completeGoogleLogin({ code: "auth-code", state: cookies.state }, cookies);
    const b = tokenBodies[0];
    expect(b.get("code_verifier")).toBe(cookies.verifier);
    expect(b.get("grant_type")).toBe("authorization_code");
    expect(b.get("code")).toBe("auth-code");
    expect(b.get("client_secret")).toBe("shh");
    expect(b.get("redirect_uri")).toBe(new URL(url).searchParams.get("redirect_uri"));
  });

  it("state mismatch fails without calling Google", async () => {
    await seedAdmin();
    const r = await run({ email: "budi@gmail.com" }, { state: "attacker-state" });
    expect(r).toEqual({ ok: false });
    expect(tokenBodies).toHaveLength(0);
  });

  it("nonce mismatch fails", async () => {
    await seedAdmin();
    expect(await run({ email: "budi@gmail.com" }, { useNonce: "other-nonce" })).toEqual({ ok: false });
  });

  it("a missing nonce claim fails", async () => {
    await seedAdmin();
    const { cookies } = buildGoogleAuthUrl();
    nextIdToken = await mint({ email: "budi@gmail.com" });
    expect(await completeGoogleLogin({ code: "c", state: cookies.state }, cookies)).toEqual({ ok: false });
  });

  it("state is single use", async () => {
    await seedAdmin();
    const { cookies } = buildGoogleAuthUrl();
    nextIdToken = await mint({ nonce: cookies.nonce, email: "budi@gmail.com" });
    expect((await completeGoogleLogin({ code: "c", state: cookies.state }, cookies)).ok).toBe(true);
    expect(await completeGoogleLogin({ code: "c", state: cookies.state }, cookies)).toEqual({ ok: false });
  });

  it.each([
    ["email_verified false", { email_verified: false }],
    ["email_verified missing", { email_verified: undefined }],
    ["email_verified as string", { email_verified: "true" }],
    ["wrong audience", { aud: "someone-else" }],
    ["wrong issuer", { iss: "https://evil.example.org" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 120 }],
    ["missing email", { email: undefined }],
  ])("%s fails", async (_n, extra) => {
    await seedAdmin();
    expect(await run({ email: "budi@gmail.com", ...extra })).toEqual({ ok: false });
  });

  it("rejects a token signed by a key that is not in Google's JWKS", async () => {
    await seedAdmin();
    expect(await run({ email: "budi@gmail.com" }, { mintOpts: { key: otherKey } })).toEqual({ ok: false });
  });

  it("rejects an HS256 token (algorithm pinned to RS256)", async () => {
    await seedAdmin();
    const { cookies } = buildGoogleAuthUrl();
    nextIdToken = await new SignJWT({ nonce: cookies.nonce, email: "budi@gmail.com", email_verified: true })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(ISS).setAudience(CLIENT_ID).setSubject("g-sub-1").setIssuedAt().setExpirationTime("5m")
      .sign(new TextEncoder().encode("s".repeat(40)));
    expect(await completeGoogleLogin({ code: "c", state: cookies.state }, cookies)).toEqual({ ok: false });
  });

  it("matches email case-insensitively and binds the Google sub on first login", async () => {
    await seedAdmin();
    const r = await run({ email: "Budi@Gmail.com", sub: "g-sub-1" });
    expect(r.ok && r.account.id).toBe("recADMIN00000001");
    expect(row("recADMIN00000001").fields[A.idGoogle]).toBe("g-sub-1");
  });

  it("a later login must present the same sub", async () => {
    await seedAdmin();
    expect((await run({ email: "budi@gmail.com", sub: "g-sub-1" })).ok).toBe(true);
    expect((await run({ email: "budi@gmail.com", sub: "g-sub-1" })).ok).toBe(true);
    expect(await run({ email: "budi@gmail.com", sub: "g-sub-2" })).toEqual({ ok: false });
    expect(row("recADMIN00000001").fields[A.idGoogle]).toBe("g-sub-1");
  });

  it("unregistered email, inactive account and locked account all give the identical result", async () => {
    await seedAccount({ id: "recINACT00000001", email: "off@gmail.com", peran: "Admin Paroki", active: false });
    await seedAccount({
      id: "recLOCK00000001", email: "lock@gmail.com", peran: "Admin Paroki",
      fields: { [A.waktuKunci]: new Date(Date.now() + 600_000).toISOString() },
    });
    const a = await run({ email: "nobody@gmail.com" });
    const b = await run({ email: "off@gmail.com" });
    const c = await run({ email: "lock@gmail.com" });
    expect(a).toEqual({ ok: false });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(store[T.akunKep]).toHaveLength(2); // never auto-creates
    expect(row("recINACT00000001").fields[A.idGoogle]).toBeUndefined();
  });

  it("token endpoint failure or a missing id_token fails closed", async () => {
    await seedAdmin();
    fetchMock.mockImplementationOnce(async () => new Response("no", { status: 400 }));
    const { cookies } = buildGoogleAuthUrl();
    expect(await completeGoogleLogin({ code: "c", state: cookies.state }, cookies)).toEqual({ ok: false });
    const c2 = buildGoogleAuthUrl().cookies;
    fetchMock.mockImplementationOnce(async () => Response.json({}));
    expect(await completeGoogleLogin({ code: "c", state: c2.state }, c2)).toEqual({ ok: false });
  });

  it("SEP and PIC still need TOTP after Google; ADMIN goes straight to a session", async () => {
    await seedAccount({ id: "recSEP000000001", email: "sep@gmail.com", peran: "SEP", mfaSecret: SEP_SECRET });
    await seedAccount({ id: "recPIC000000001", email: "pic@gmail.com", peran: "PIC Paroki", mfaSecret: SEP_SECRET });
    await seedAccount({ id: "recNEW0000000001", email: "new@gmail.com", peran: "SEP" });
    await seedAdmin();
    await seedAccount({ id: "recADM2000000001", email: "adm2@gmail.com", peran: "Admin Paroki", mfaSecret: SEP_SECRET });
    const next = async (email: string) => {
      const r = await run({ email });
      return r.ok ? r.next : "fail";
    };
    expect(await next("sep@gmail.com")).toBe("mfa");
    expect(await next("pic@gmail.com")).toBe("mfa");
    expect(await next("new@gmail.com")).toBe("mfa_enroll");
    expect(await next("budi@gmail.com")).toBe("session");
    expect(await next("adm2@gmail.com")).toBe("mfa"); // enrolled admin keeps using MFA
  });
});

// ---- routes ----
const reqGet = (path: string, cookie = "") =>
  new Request("https://kep.example.org" + path, { headers: cookie ? { cookie } : {} });
const postJson = (path: string, body: unknown, cookie = "") =>
  new Request("https://kep.example.org" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://kep.example.org",
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function startFlow() {
  const res = await start(reqGet("/api/auth/google/start"));
  const loc = new URL(res.headers.get("location")!);
  return { res, loc, cookie: cookiesOf(res) };
}
async function finishFlow(claims: Claims, o: { cookie?: string; state?: string } = {}) {
  const s = await startFlow();
  const flow = await readFlowCookie(o.cookie ?? s.cookie);
  nextIdToken = await mint({ nonce: flow?.nonce ?? "x", ...claims });
  const q = new URLSearchParams({ code: "auth-code", state: o.state ?? s.loc.searchParams.get("state")! });
  return callback(reqGet("/api/auth/google/callback?" + q, o.cookie ?? s.cookie));
}

describe("routes", () => {
  it("start redirects to Google with a hardened, signed flow cookie", async () => {
    const { res, loc } = await startFlow();
    expect(res.status).toBe(302);
    expect(loc.origin).toBe("https://accounts.google.com");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const c = res.headers.getSetCookie()[0];
    expect(c).toMatch(/^__Host-kep_gflow=/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Path=\//);
    expect(c).not.toContain(loc.searchParams.get("state")!); // opaque JWT, not raw values
  });

  it("start is rate limited per IP", async () => {
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await start(reqGet("/api/auth/google/start"))).status;
    expect(last).toBe(429);
  });

  it("every failure redirects to the same fixed URL (no account enumeration, no open redirect)", async () => {
    await seedAccount({ id: "recINACT00000001", email: "off@gmail.com", peran: "Admin Paroki", active: false });
    const results = [
      await finishFlow({ email: "nobody@gmail.com" }),
      await finishFlow({ email: "off@gmail.com" }),
      await finishFlow({ email: "x@gmail.com", email_verified: false }),
      await finishFlow({ email: "x@gmail.com" }, { state: "wrong" }),
      await callback(reqGet("/api/auth/google/callback?error=access_denied")),
      await callback(reqGet("/api/auth/google/callback?code=a&state=b")), // no flow cookie
    ];
    for (const r of results) {
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("https://kep.example.org/login?error=google");
      expect(r.headers.getSetCookie().join(";")).not.toMatch(/kep_session/);
    }
  });

  it("ADMIN success sets the session cookie and redirects to a fixed destination", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "budi@gmail.com", peran: "Admin Paroki" });
    const res = await finishFlow({ email: "Budi@Gmail.com" });
    expect(res.headers.get("location")).toBe("https://kep.example.org/kep");
    const c = res.headers.getSetCookie();
    const sess = c.find((x) => x.startsWith("__Host-kep_session="))!;
    expect(sess).toMatch(/HttpOnly/);
    expect(c.some((x) => x.startsWith("__Host-kep_gflow=;") && /Max-Age=0/.test(x))).toBe(true);
    expect((await readSession(cookiesOf(res)))?.role).toBe("ADMIN");
    await flushBackground();
    expect(row("recADMIN00000001").fields[A.loginTerakhir]).toBeDefined();
  });

  it("a replayed callback (same flow cookie + state) fails", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "budi@gmail.com", peran: "Admin Paroki" });
    const s = await startFlow();
    const flow = (await readFlowCookie(s.cookie))!;
    const q = new URLSearchParams({ code: "c", state: s.loc.searchParams.get("state")! });
    nextIdToken = await mint({ nonce: flow.nonce, email: "budi@gmail.com" });
    const a = await callback(reqGet("/api/auth/google/callback?" + q, s.cookie));
    const b = await callback(reqGet("/api/auth/google/callback?" + q, s.cookie));
    expect(a.headers.get("location")).toBe("https://kep.example.org/kep");
    expect(b.headers.get("location")).toBe("https://kep.example.org/login?error=google");
  });

  it("SEP: Google alone gives NO session; TOTP completes it with amr otp; wrong code is rejected", async () => {
    await seedAccount({ id: "recSEP000000001", email: "sep@gmail.com", peran: "SEP", mfaSecret: SEP_SECRET });
    const res = await finishFlow({ email: "sep@gmail.com" });
    expect(res.headers.get("location")).toBe("https://kep.example.org/login?step=mfa");
    const cookie = cookiesOf(res);
    expect(cookie).not.toMatch(/kep_session=[^;]/);
    expect(await readSession(cookie)).toBeNull();

    expect((await googleMfa(postJson("/api/auth/google/mfa", { code: "000000" }, cookie))).status).toBe(401);
    expect((await googleMfa(postJson("/api/auth/google/mfa", { code: "123456" }))).status).toBe(401); // no cookie

    const ok = await googleMfa(postJson("/api/auth/google/mfa", { code: generateSync({ secret: SEP_SECRET }) }, cookie));
    expect(ok.status).toBe(200);
    const sess = await readSession(cookiesOf(ok));
    expect(sess?.role).toBe("SEP");
    // replaying the same code on a fresh Google login is refused (TOTP replay protection)
    const res2 = await finishFlow({ email: "sep@gmail.com" });
    const again = await googleMfa(postJson("/api/auth/google/mfa", { code: generateSync({ secret: SEP_SECRET }) }, cookiesOf(res2)));
    expect(again.status).toBe(401);
  });

  it("the TOTP step is rate limited (5 codes per 15 min)", async () => {
    await seedAccount({ id: "recSEP000000001", email: "sep@gmail.com", peran: "SEP", mfaSecret: SEP_SECRET });
    const cookie = cookiesOf(await finishFlow({ email: "sep@gmail.com" }));
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await googleMfa(postJson("/api/auth/google/mfa", { code: "000000" }, cookie))).status);
    expect(codes.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(codes[6]).toBe(429);
  });

  it("the TOTP verify cookie cannot be used on the enrollment route, nor the reverse", async () => {
    await seedAccount({ id: "recSEP000000001", email: "sep@gmail.com", peran: "SEP", mfaSecret: SEP_SECRET });
    const cookie = cookiesOf(await finishFlow({ email: "sep@gmail.com" }));
    expect((await enroll(postJson("/api/auth/mfa/enroll", {}, cookie))).status).toBe(401);
  });

  it("SEP without MFA enrolls through the Google pre-auth, then gets amr google+otp", async () => {
    await seedAccount({ id: "recNEW0000000001", email: "new@gmail.com", peran: "SEP" });
    const res = await finishFlow({ email: "new@gmail.com", sub: "g-new" });
    expect(res.headers.get("location")).toBe("https://kep.example.org/login?step=enroll");
    const pre = cookiesOf(res);
    expect(await readSession(pre)).toBeNull();
    const s1 = await enroll(postJson("/api/auth/mfa/enroll", {}, pre));
    expect(s1.status).toBe(200);
    const { secret } = (await s1.json()) as { secret: string };
    const s2 = await enroll(postJson("/api/auth/mfa/enroll", { code: generateSync({ secret }) }, cookiesOf(s1)));
    expect(s2.status).toBe(200);
    expect((await readSession(cookiesOf(s2)))?.role).toBe("SEP");
  });

  it("a Google enroll pre-auth is void once the bound Google sub changes", async () => {
    await seedAccount({ id: "recNEW0000000001", email: "new@gmail.com", peran: "SEP" });
    const pre = cookiesOf(await finishFlow({ email: "new@gmail.com", sub: "g-new" }));
    row("recNEW0000000001").fields[A.idGoogle] = "g-other";
    expect((await enroll(postJson("/api/auth/mfa/enroll", {}, pre))).status).toBe(401);
  });

  it("amr: ADMIN session is [google]; SEP after TOTP is [google, otp]", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "budi@gmail.com", peran: "Admin Paroki" });
    await seedAccount({ id: "recSEP000000001", email: "sep@gmail.com", peran: "SEP", mfaSecret: SEP_SECRET });
    const tok = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("__Host-kep_session="))!.split(";")[0].split("=")[1];
    expect(decodeJwt(tok(await finishFlow({ email: "budi@gmail.com" }))).amr).toEqual(["google"]);
    const pre = cookiesOf(await finishFlow({ email: "sep@gmail.com" }));
    const ok = await googleMfa(postJson("/api/auth/google/mfa", { code: generateSync({ secret: SEP_SECRET }) }, pre));
    expect(decodeJwt(tok(ok)).amr).toEqual(["google", "otp"]);
  });

  it("amr after Google enrollment is [google, otp]", async () => {
    await seedAccount({ id: "recNEW0000000001", email: "new@gmail.com", peran: "SEP" });
    const pre = cookiesOf(await finishFlow({ email: "new@gmail.com" }));
    const s1 = await enroll(postJson("/api/auth/mfa/enroll", {}, pre));
    const { secret } = (await s1.json()) as { secret: string };
    const s2 = await enroll(postJson("/api/auth/mfa/enroll", { code: generateSync({ secret }) }, cookiesOf(s1)));
    const t = s2.headers.getSetCookie().find((c) => c.startsWith("__Host-kep_session="))!.split(";")[0].split("=")[1];
    expect(decodeJwt(t).amr).toEqual(["google", "otp"]);
  });

  it("the enroll pre-auth cookie is rejected by the Google MFA route", async () => {
    await seedAccount({ id: "recNEW0000000001", email: "new@gmail.com", peran: "SEP", mfaSecret: SEP_SECRET });
    const enrollPre = cookiesOf(await finishFlow({ email: "new@gmail.com" })).replace("kep_preauth_verify", "kep_preauth");
    expect((await googleMfa(postJson("/api/auth/google/mfa", { code: "123456" }, enrollPre))).status).toBe(401);
    await seedAccount({ id: "recNEW0000000002", email: "n2@gmail.com", peran: "SEP" });
    const real = cookiesOf(await finishFlow({ email: "n2@gmail.com" }));
    expect((await googleMfa(postJson("/api/auth/google/mfa", { code: "123456" }, real.replace("kep_preauth", "kep_preauth_verify")))).status).toBe(401);
  });

  it("sub mismatch, locked and unknown accounts redirect identically", async () => {
    await seedAccount({ id: "recBOUND0000001", email: "bound@gmail.com", peran: "Admin Paroki", fields: { [A.idGoogle]: "other-sub" } });
    await seedAccount({
      id: "recLOCK00000001", email: "lock@gmail.com", peran: "Admin Paroki",
      fields: { [A.waktuKunci]: new Date(Date.now() + 600_000).toISOString() },
    });
    const rs = [
      await finishFlow({ email: "bound@gmail.com", sub: "g-sub-1" }),
      await finishFlow({ email: "lock@gmail.com" }),
      await finishFlow({ email: "nobody@gmail.com" }),
    ];
    for (const r of rs) {
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("https://kep.example.org/login?error=google");
      expect(r.headers.getSetCookie().map((c) => c.split("=")[0])).toEqual(["__Host-kep_gflow"]);
    }
  });
});

describe("first-binding trust", () => {
  it("a non-Google-authoritative domain without hd is refused and nothing is bound", async () => {
    await seedAccount({ id: "recSEP000000001", email: "umat@parokixyz.org", peran: "SEP" });
    await seedAccount({ id: "recADMIN00000001", email: "adm@parokixyz.org", peran: "Admin Paroki" });
    expect(await run({ email: "umat@parokixyz.org" })).toEqual({ ok: false });
    expect(await run({ email: "adm@parokixyz.org" })).toEqual({ ok: false });
    expect(row("recSEP000000001").fields[A.idGoogle]).toBeUndefined();
    expect(row("recADMIN00000001").fields[A.idGoogle]).toBeUndefined();
    expect(store[T.auditKep] ?? []).toHaveLength(0);
    const res = await finishFlow({ email: "adm@parokixyz.org" });
    expect(res.headers.get("location")).toBe("https://kep.example.org/login?error=google");
  });

  it("hd equal to the email domain is authoritative; a different hd is not", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "adm@parokixyz.org", peran: "Admin Paroki" });
    expect(await run({ email: "adm@parokixyz.org", hd: "other.org" })).toEqual({ ok: false });
    expect((await run({ email: "adm@parokixyz.org", hd: "parokixyz.org" })).ok).toBe(true);
    expect(row("recADMIN00000001").fields[A.idGoogle]).toBe("g-sub-1");
  });

  it("a bound non-gmail account may keep logging in (binding done earlier by an admin)", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "adm@parokixyz.org", peran: "Admin Paroki", fields: { [A.idGoogle]: "g-sub-1" } });
    expect((await run({ email: "adm@parokixyz.org" })).ok).toBe(true);
  });

  it("every first binding writes an audit row with only the last 4 chars of the sub", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "budi@gmail.com", peran: "Admin Paroki" });
    await run({ email: "budi@gmail.com", sub: "1234567890abcdef" });
    await run({ email: "budi@gmail.com", sub: "1234567890abcdef" }); // not a new binding
    const rows = store[T.auditKep];
    expect(rows).toHaveLength(1);
    expect(rows[0].fields).toEqual({
      [F.auditKep.aksi]: "google_bind",
      [F.auditKep.pelaku]: "budi@gmail.com",
      [F.auditKep.targetId]: "recADMIN00000001",
      [F.auditKep.sesudah]: "cdef",
    });
  });

  it("concurrent first logins with different subs: at most one wins and it is the stored sub", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "budi@gmail.com", peran: "Admin Paroki" });
    const rs = await Promise.all([
      run({ email: "budi@gmail.com", sub: "sub-AAAA" }),
      run({ email: "budi@gmail.com", sub: "sub-BBBB" }),
    ]);
    const wins = rs.filter((r) => r.ok);
    expect(wins.length).toBeLessThanOrEqual(1);
    const stored = row("recADMIN00000001").fields[A.idGoogle];
    if (wins.length === 1) expect(["sub-AAAA", "sub-BBBB"][rs.indexOf(wins[0])]).toBe(stored);
  });

  it("accepts the bare issuer accounts.google.com; rejects a mismatching azp", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "budi@gmail.com", peran: "Admin Paroki" });
    expect((await run({ email: "budi@gmail.com", iss: "accounts.google.com" })).ok).toBe(true);
    expect(await run({ email: "budi@gmail.com", azp: "someone-else" })).toEqual({ ok: false });
    expect((await run({ email: "budi@gmail.com", azp: CLIENT_ID })).ok).toBe(true);
  });
});
