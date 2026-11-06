import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { generateSync } from "otplib";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from "jose";
import { F, T } from "@/lib/airtable/schema";
import { PASSWORD, fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import { POST as linkStart } from "@/app/api/auth/google/link/route";
import { GET as callback } from "@/app/api/auth/google/callback/route";
import { SESSION_COOKIE, clearSessionCache, issueSession, readSession, type Session } from "@/lib/auth/session";
import { FLOW_COOKIE, readFlowCookie } from "@/lib/auth/google";
import { generateTotpSecret } from "@/lib/auth/totp";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const A = F.akunKep;
const PA = "recPAROKIA0000001";
const CLIENT_ID = "client-123.apps.googleusercontent.com";
const secret = generateTotpSecret();
const pic: Session = { accountId: "recPIC0000000001", email: "pic@paroki.id", role: "PIC", parokiId: PA };
const adm: Session = { accountId: "recADM0000000001", email: "adm@paroki.id", role: "ADMIN", parokiId: PA };
const row = (id: string) => store[T.akunKep].find((r) => r.id === id)!;

let signKey: CryptoKey;
let jwks: { keys: JWK[] };
let nextIdToken = "";

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  signKey = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});

const mint = (claims: Record<string, unknown>) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(CLIENT_ID)
    .setSubject((claims.sub as string) ?? "g-sub-1")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signKey);
};

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "shh");
  vi.stubEnv("GOOGLE_REDIRECT_BASE", "https://kep.example.org");
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return Response.json(jwks);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ id_token: nextIdToken });
    throw new Error("unexpected network call: " + url);
  }));
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", mfaSecret: secret, fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: adm.accountId, email: adm.email, peran: "Admin Paroki", fields: { [A.paroki]: [PA] } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const sessionCookie = async (s: Session) => `${SESSION_COOKIE}=${await issueSession(s, { amr: ["pwd", "otp"] })}`;
async function start(s: Session, body: unknown) {
  return linkStart(
    new Request("https://kep.test/api/auth/google/link", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", cookie: await sessionCookie(s) },
      body: JSON.stringify(body),
    }),
  );
}
const flowCookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith(FLOW_COOKIE + "="))!.split(";")[0];

async function finishLink(s: Session, googleClaims: Record<string, unknown>, o: { sessionAs?: Session } = {}) {
  const res = await start(s, s.role === "ADMIN" ? { password: PASSWORD } : { code: generateSync({ secret }) });
  expect(res.status).toBe(200);
  const { url } = await res.json();
  const u = new URL(url);
  const flow = (await readFlowCookie(flowCookieOf(res)))!;
  nextIdToken = await mint({ nonce: u.searchParams.get("nonce"), ...googleClaims });
  const cb = await callback(
    new Request(`https://kep.example.org/api/auth/google/callback?code=c&state=${u.searchParams.get("state")}`, {
      headers: { cookie: `${flowCookieOf(res)}; ${await sessionCookie(o.sessionAs ?? s)}` },
    }),
  );
  return { cb, flow };
}

describe("link Google from a logged-in session", () => {
  it("needs a session", async () => {
    const res = await linkStart(
      new Request("https://kep.test/x", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  it("SEP/PIC must re-authenticate with a current TOTP code", async () => {
    expect((await start(pic, {})).status).toBe(403);
    expect((await start(pic, { code: "000000" })).status).toBe(403);
    expect((await start(pic, { password: PASSWORD })).status).toBe(403); // password alone is not enough for MFA accounts
    expect((await start(pic, { code: generateSync({ secret }) })).status).toBe(200);
  });

  it("an Admin without MFA re-authenticates with the password", async () => {
    expect((await start(adm, {})).status).toBe(403);
    expect((await start(adm, { password: "wrong password here" })).status).toBe(403);
    expect((await start(adm, { password: PASSWORD })).status).toBe(200);
  });

  it("binds the sub for a non-Google-authoritative domain, audits it and keeps the user logged in", async () => {
    const { cb } = await finishLink(pic, { email: "pic@paroki.id", sub: "g-sub-pic-1" });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toContain("/profil");
    expect(cb.headers.get("location")).not.toContain("error");
    expect(row(pic.accountId).fields[A.idGoogle]).toBe("g-sub-pic-1");
    expect((store[T.auditKep] ?? []).some((a) => a.fields[F.auditKep.aksi] === "google_bind")).toBe(true);
    const fresh = cb.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE + "="))!;
    expect((await readSession(fresh.split(";")[0]))?.accountId).toBe(pic.accountId);
  });

  it("refuses when the Google address differs from the account email", async () => {
    const { cb } = await finishLink(pic, { email: "someone-else@gmail.com", sub: "g-sub-x" });
    expect(cb.headers.get("location")).toContain("google=gagal");
    expect(row(pic.accountId).fields[A.idGoogle]).toBeUndefined();
  });

  it("refuses to overwrite a different existing binding (SEP must clear it first)", async () => {
    row(pic.accountId).fields[A.idGoogle] = "g-old";
    const { cb } = await finishLink(pic, { email: "pic@paroki.id", sub: "g-new" });
    expect(cb.headers.get("location")).toContain("google=gagal");
    expect(row(pic.accountId).fields[A.idGoogle]).toBe("g-old");
  });

  it("the flow only completes for the session that started it", async () => {
    const { cb } = await finishLink(pic, { email: "pic@paroki.id", sub: "g-sub-pic-1" }, { sessionAs: adm });
    expect(cb.headers.get("location")).toContain("google=gagal");
    expect(row(pic.accountId).fields[A.idGoogle]).toBeUndefined();
    expect(row(adm.accountId).fields[A.idGoogle]).toBeUndefined();
  });
});
