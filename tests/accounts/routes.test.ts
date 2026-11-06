import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { generateSync } from "otplib";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/auth/reauth", async (orig) => {
  const m = await orig<typeof import("@/lib/auth/reauth")>();
  return { reauthenticate: vi.fn(m.reauthenticate) };
});

import { GET as listAkun, POST as createAkun } from "@/app/api/akun/route";
import { PATCH as patchAkun } from "@/app/api/akun/[id]/route";
import { POST as resetRequest } from "@/app/api/auth/reset/request/route";
import { POST as resetConfirm } from "@/app/api/auth/reset/confirm/route";
import { POST as mfaManage } from "@/app/api/auth/mfa/manage/route";
import { setMailer } from "@/lib/email";
import { SESSION_COOKIE, clearSessionCache, issueSession, readSession, type Session } from "@/lib/auth/session";
import { decryptSecret, encryptSecret, generateTotpSecret } from "@/lib/auth/totp";
import { flushBackground } from "@/lib/background";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const A = F.akunKep;
const PA = "recPAROKIA0000001";
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const sep2: Session = { accountId: "recSEPB000000001", email: "sepb@x.id", role: "SEP", parokiId: null };
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const adm: Session = { accountId: "recADM0000000001", email: "adm@x.id", role: "ADMIN", parokiId: PA };
const row = (id: string) => store[T.akunKep].find((r) => r.id === id)!;
const strong = "tangga-biru-melompat-77!";
let sent: { to: string; template: string; link: string }[];
let ipN = 0;

const cookie = async (s: Session) => `${SESSION_COOKIE}=${await issueSession(s, { amr: ["pwd", "otp"] })}`;
async function call(
  handler: (req: Request, ctx?: never) => Promise<Response>,
  body: unknown,
  o: { as?: Session; method?: string; ip?: string; headers?: Record<string, string>; params?: object } = {},
) {
  const req = new Request("https://kep.test/api/x", {
    method: o.method ?? "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-real-ip": o.ip ?? `10.0.0.${++ipN % 250}`,
      ...(o.as ? { cookie: await cookie(o.as) } : {}),
      ...o.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (handler as (r: Request, c: unknown) => Promise<Response>)(req, o.params ? { params: Promise.resolve(o.params) } : undefined);
}

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("APP_BASE_URL", "https://kep.example.org");
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  sent = [];
  setMailer({ send: async (to, template, data) => void sent.push({ to, template, link: data.link }) });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("0000000000000000000000000000000000A:0\r\n")));
  store[T.paroki] = [{ id: PA, fields: {} }];
  await seedAccount({ id: sep.accountId, email: sep.email, peran: "SEP" });
  await seedAccount({ id: sep2.accountId, email: sep2.email, peran: "SEP" });
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: adm.accountId, email: adm.email, peran: "Admin Paroki", fields: { [A.paroki]: [PA] } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setMailer(null);
});

describe("reset request route", () => {
  it("returns the identical response for known and unknown emails", async () => {
    const a = await call(resetRequest, { email: "sepa@x.id" });
    const b = await call(resetRequest, { email: "nobody@x.id" });
    await flushBackground();
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
    expect(sent.map((m) => m.to)).toEqual(["sepa@x.id"]);
  });

  it("malformed input gets the same generic answer", async () => {
    const ok = await (await call(resetRequest, { email: "nobody@x.id" })).text();
    expect(await (await call(resetRequest, { email: 42 })).text()).toBe(ok);
    expect(await (await call(resetRequest, {})).text()).toBe(ok);
  });

  it("rate limits per email silently (same 200, no more mail) and per IP with 429", async () => {
    const r: Response[] = [];
    for (let i = 0; i < 6; i++) r.push(await call(resetRequest, { email: "sepa@x.id" }));
    await flushBackground();
    expect(new Set(r.map((x) => x.status))).toEqual(new Set([200]));
    expect(sent.length).toBe(3);
    // same limit behaviour for an unknown address: indistinguishable
    const u = [];
    for (let i = 0; i < 6; i++) u.push((await call(resetRequest, { email: "ghost@x.id" })).status);
    expect(new Set(u)).toEqual(new Set([200]));
    const ip = "9.9.9.9";
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await call(resetRequest, { email: `u${i}@x.id` }, { ip })).status;
    expect(last).toBe(429);
  });

  it("requires a same-origin JSON request", async () => {
    const res = await call(resetRequest, { email: "sepa@x.id" }, { headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
  });
});

describe("reset confirm route", () => {
  it("sets the password with a valid link; reuse and bad input are generic errors", async () => {
    await call(resetRequest, { email: "sepa@x.id" });
    await flushBackground();
    const token = new URL(sent[0].link).hash.slice("#token=".length);
    const weak = await call(resetConfirm, { token, password: "short" });
    expect(weak.status).toBe(422);
    const ok = await call(resetConfirm, { token, password: strong });
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie()).toEqual([]); // no auto-login
    const again = await call(resetConfirm, { token, password: strong + "1" });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/tautan/i);
    expect((await call(resetConfirm, { token: "junk", password: strong })).status).toBe(400);
    expect((await call(resetConfirm, { token: 5, password: strong })).status).toBe(400);
  });

  it("is rate limited per IP", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await call(resetConfirm, { token: "junk", password: strong }, { ip: "8.8.8.8" })).status;
    expect(last).toBe(429);
  });
});

describe("/api/akun", () => {
  it("401 without a session, 403 for PIC and ADMIN", async () => {
    expect((await call(listAkun, undefined, { method: "GET" })).status).toBe(401);
    expect((await call(listAkun, undefined, { method: "GET", as: pic })).status).toBe(403);
    expect((await call(createAkun, { email: "a@b.id", nama: "A", role: "SEP" }, { as: adm })).status).toBe(403);
  });

  it("SEP lists accounts without credentials", async () => {
    row(pic.accountId).fields[A.idGoogle] = "g-sub-secret-9999";
    const res = await call(listAkun, undefined, { method: "GET", as: sep });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/argon2|g-sub-secret|Hash|rahasia/i);
    const rows = JSON.parse(text).akun as { email: string; googleTerhubung: boolean; mfa: boolean }[];
    expect(rows.find((r) => r.email === pic.email)?.googleTerhubung).toBe(true);
  });

  it("SEP creates an account; request body cannot smuggle other fields", async () => {
    const res = await call(createAkun, {
      email: "baru@x.id", nama: "Baru", role: "PIC", parokiId: PA,
      [A.hashPassword]: "evil", hashPassword: "evil", statusAktif: false, [A.rahasiaMfa]: "x",
    }, { as: sep });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/evil|hash/i);
    const created = store[T.akunKep].find((r) => r.fields[A.email] === "baru@x.id")!;
    expect(String(created.fields[A.hashPassword])).toMatch(/^unset:/);
    expect(created.fields[A.rahasiaMfa]).toBeUndefined();
    expect(created.fields[A.statusAktif]).toBe(true);
    expect((await call(createAkun, { email: "baru@x.id", nama: "Baru", role: "PIC", parokiId: PA }, { as: sep })).status).toBe(409);
    expect((await call(createAkun, { email: "x@x.id", nama: "X", role: "PIC" }, { as: sep })).status).toBe(422);
  });

  it("reset_mfa and clear_google through the route need the acting SEP's code", async () => {
    row(pic.accountId).fields[A.idGoogle] = "g-sub-1";
    const params = { id: pic.accountId };
    const r = await call(patchAkun, { action: "clear_google" }, { method: "PATCH", as: sep, params });
    expect(r.status).toBe(403); // sep has no authenticator / no code
    expect(row(pic.accountId).fields[A.idGoogle]).toBe("g-sub-1");
  });

  it("PATCH actions work for SEP only and map errors", async () => {
    const params = { id: pic.accountId };
    expect((await call(patchAkun, { action: "deactivate" }, { method: "PATCH", as: pic, params })).status).toBe(403);
    expect((await call(patchAkun, { action: "bogus" }, { method: "PATCH", as: sep, params })).status).toBe(400);
    expect((await call(patchAkun, { action: "set_role", role: "ADMIN", parokiId: PA }, { method: "PATCH", as: sep, params })).status).toBe(200);
    expect(row(pic.accountId).fields[A.peran]).toBe("Admin Paroki");
    expect((await call(patchAkun, { action: "deactivate" }, { method: "PATCH", as: sep, params })).status).toBe(200);
    expect((await call(patchAkun, { action: "deactivate" }, { method: "PATCH", as: sep, params: { id: "recNOPE000000001" } })).status).toBe(404);
    // last SEP protection through the route
    await call(patchAkun, { action: "deactivate" }, { method: "PATCH", as: sep, params: { id: sep2.accountId } });
    const last = await call(patchAkun, { action: "deactivate" }, { method: "PATCH", as: sep, params: { id: sep.accountId } });
    expect(last.status).toBe(409);
  });
});

describe("/api/auth/mfa/manage (logged in)", () => {
  const code = (secret: string) => generateSync({ secret });

  it("first-time enrollment for an Admin returns secret + QR data URI, then stores on a valid code", async () => {
    const s1 = await call(mfaManage, {}, { as: adm });
    expect(s1.status).toBe(200);
    const b = await s1.json();
    expect(b.qr).toMatch(/^data:image\/png;base64,/);
    expect(b.otpauthUri).toContain("otpauth://totp/");
    const bad = await call(mfaManage, { pending: b.pending, code: "000000" }, { as: adm });
    expect(bad.status).toBe(400);
    expect(row(adm.accountId).fields[A.rahasiaMfa]).toBeUndefined();
    // a stolen session alone cannot bind an authenticator: the account password is required
    const noPw = await call(mfaManage, { pending: b.pending, code: code(b.secret) }, { as: adm });
    expect(noPw.status).toBe(403);
    expect((await call(mfaManage, { pending: b.pending, code: code(b.secret), password: "wrong wrong wrong" }, { as: adm })).status).toBe(403);
    expect(row(adm.accountId).fields[A.rahasiaMfa]).toBeUndefined();
    const done = await call(mfaManage, { pending: b.pending, code: code(b.secret), password: "correct horse battery staple" }, { as: adm });
    expect(done.status).toBe(200);
    expect(decryptSecret(String(row(adm.accountId).fields[A.rahasiaMfa]))).toBe(b.secret);
    // the response carries a fresh session so the user is not logged out by their own change
    const set = done.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE + "="))!;
    expect(await readSession(set.split(";")[0])).not.toBeNull();
  });

  it("replacing an existing secret needs the CURRENT code at both steps", async () => {
    const old = generateTotpSecret();
    await seedAccount({ id: "recADM2000000001", email: "adm2@x.id", peran: "Admin Paroki", mfaSecret: old, fields: { [A.paroki]: [PA] } });
    const me: Session = { accountId: "recADM2000000001", email: "adm2@x.id", role: "ADMIN", parokiId: PA };
    expect((await call(mfaManage, {}, { as: me })).status).toBe(403);
    expect((await call(mfaManage, { currentCode: "123456" }, { as: me })).status).toBe(403);
    const s1 = await call(mfaManage, { currentCode: code(old) }, { as: me });
    expect(s1.status).toBe(200);
    const b = await s1.json();
    // an attacker with a stolen session but without the current code cannot finish
    const hijack = await call(mfaManage, { pending: b.pending, code: code(b.secret) }, { as: me });
    expect(hijack.status).toBe(403);
    expect(decryptSecret(String(row("recADM2000000001").fields[A.rahasiaMfa]))).toBe(old);
  });

  it("replacing with the current code at both steps works and keeps the user logged in", async () => {
    const old = generateTotpSecret();
    await seedAccount({ id: "recADM2000000001", email: "adm2@x.id", peran: "Admin Paroki", mfaSecret: old, fields: { [A.paroki]: [PA] } });
    const me: Session = { accountId: "recADM2000000001", email: "adm2@x.id", role: "ADMIN", parokiId: PA };
    const b = await (await call(mfaManage, { currentCode: code(old) }, { as: me })).json();
    const done = await call(mfaManage, { pending: b.pending, code: code(b.secret), currentCode: code(old) }, { as: me });
    expect(done.status).toBe(200);
    expect(decryptSecret(String(row("recADM2000000001").fields[A.rahasiaMfa]))).toBe(b.secret);
    expect(typeof row("recADM2000000001").fields[A.langkahTotpTerakhir]).toBe("number");
    const set = done.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE + "="))!;
    expect(await readSession(set.split(";")[0])).not.toBeNull();
    expect((store[T.auditKep] ?? []).some((a) => a.fields[F.auditKep.aksi] === "mfa_ganti")).toBe(true);
  });

  it("a pending blob from another account is useless", async () => {
    const b = await (await call(mfaManage, {}, { as: adm })).json();
    const res = await call(mfaManage, { pending: b.pending, code: code(b.secret) }, { as: pic });
    // pic is SEP/PIC with enrolled? pic has no secret in this seed; blob is bound to adm
    expect([400, 403]).toContain(res.status);
    expect(row(pic.accountId).fields[A.rahasiaMfa]).toBeUndefined();
  });

  it("wrong current codes are rate limited", async () => {
    await seedAccount({ id: "recADM2000000001", email: "adm2@x.id", peran: "Admin Paroki", mfaSecret: generateTotpSecret(), fields: { [A.paroki]: [PA] } });
    const me: Session = { accountId: "recADM2000000001", email: "adm2@x.id", role: "ADMIN", parokiId: PA };
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await call(mfaManage, { currentCode: "000000" }, { as: me })).status;
    expect(last).toBe(429);
  });

  it("requires a session", async () => {
    expect((await call(mfaManage, {})).status).toBe(401);
  });
});
void encryptSecret;
