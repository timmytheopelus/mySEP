import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { generateSync } from "otplib";
import { F, T } from "@/lib/airtable/schema";
import { PASSWORD, fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/auth/password", async (orig) => {
  const m = await orig<typeof import("@/lib/auth/password")>();
  return { ...m, verifyPassword: vi.fn(m.verifyPassword) };
});

import * as airtable from "@/lib/airtable/client";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as enroll } from "@/app/api/auth/mfa/enroll/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { clearSessionCache, readSession } from "@/lib/auth/session";
import { flushBackground } from "@/lib/background";
import { resetRateLimitMemory } from "@/lib/ratelimit";
import * as pw from "@/lib/auth/password";
import { generateTotpSecret, decryptSecret } from "@/lib/auth/totp";

const A = F.akunKep;
const req = (body: unknown, cookie = "") =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const row = (id: string) => store[T.akunKep].find((r) => r.id === id)!;
const settle = () => flushBackground();
const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieHeaderFrom = (res: Response) => setCookies(res).map((c) => c.split(";")[0]).join("; ");
let clockEpoch = 1_800_000_015;

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  clockEpoch += 600; // each test gets fresh TOTP steps
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clockEpoch * 1000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("login failures are uniform", () => {
  it("unknown email and wrong password give identical status and body", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "a@x.id", peran: "Admin Paroki" });
    const a = await login(req({ email: "nobody@x.id", password: "whatever-whatever" }));
    const b = await login(req({ email: "a@x.id", password: "wrong-password-123" }));
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const [ja, jb] = [await a.json(), await b.json()];
    expect(ja).toEqual(jb);
    expect(jb).toEqual({ error: "Email atau password salah" });
  });

  it("inactive account is indistinguishable too", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "a@x.id", peran: "Admin Paroki", active: false });
    const r = await login(req({ email: "a@x.id", password: PASSWORD }));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "Email atau password salah" });
  });

  it("5 wrong passwords lock the account even for the correct password, with the same message", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "a@x.id", peran: "Admin Paroki" });
    for (let i = 0; i < 5; i++) {
      const r = await login(req({ email: "A@x.id", password: "wrong-password-123" }));
      expect(r.status).toBe(401);
    }
    await settle();
    expect(row("recADMIN00000001").fields[A.waktuKunci]).toBeTruthy();
    const r = await login(req({ email: "a@x.id", password: PASSWORD }));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "Email atau password salah" });
    expect(setCookies(r)).toEqual([]);
    // lock expires
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect((await login(req({ email: "a@x.id", password: PASSWORD }))).status).toBe(200);
  });

  it("a success resets the failure count", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "a@x.id", peran: "Admin Paroki" });
    for (let i = 0; i < 3; i++) await login(req({ email: "a@x.id", password: "wrong-password-123" }));
    await settle();
    expect(row("recADMIN00000001").fields[A.gagalLogin]).toBe(3);
    expect((await login(req({ email: "a@x.id", password: PASSWORD }))).status).toBe(200);
    expect(row("recADMIN00000001").fields[A.gagalLogin]).toBe(0);
  });
});

describe("MFA", () => {
  it("PIC with correct password and no totp -> next: mfa, no session", async () => {
    await seedAccount({ id: "recPIC000000001A", email: "pic@x.id", peran: "PIC Paroki", mfaSecret: generateTotpSecret() });
    const r = await login(req({ email: "pic@x.id", password: PASSWORD }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ next: "mfa" });
    expect(setCookies(r).some((c) => c.startsWith("__Host-kep_session=") && !c.includes("Max-Age=0"))).toBe(false);
  });

  it("PIC with a correct totp gets a hardened kep_session cookie; step persisted, replay rejected", async () => {
    const secret = generateTotpSecret();
    await seedAccount({ id: "recPIC000000001A", email: "pic@x.id", peran: "PIC Paroki", mfaSecret: secret });
    const code = generateSync({ secret, epoch: Date.now() / 1000 });
    const r = await login(req({ email: "pic@x.id", password: PASSWORD, totp: code }));
    expect(r.status).toBe(200);
    const c = setCookies(r).find((x) => x.startsWith("__Host-kep_session="))!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/Path=\/;/);
    expect(c).toMatch(/SameSite=Lax/);
    const step = row("recPIC000000001A").fields[A.langkahTotpTerakhir];
    expect(step).toBe(Math.floor(Date.now() / 1000 / 30));
    expect((await readSession(cookieHeaderFrom(r)))?.role).toBe("PIC");
    // same code again = replay
    expect((await login(req({ email: "pic@x.id", password: PASSWORD, totp: code }))).status).toBe(401);
  });

  it("totp step 0 is valid and is persisted as 0 (not treated as missing)", async () => {
    const secret = generateTotpSecret();
    await seedAccount({ id: "recPIC000000001A", email: "pic@x.id", peran: "PIC Paroki", mfaSecret: secret });
    vi.setSystemTime(15_000); // time step 0
    const r = await login(req({ email: "pic@x.id", password: PASSWORD, totp: generateSync({ secret, epoch: 15 }) }));
    expect(r.status).toBe(200);
    expect(row("recPIC000000001A").fields[A.langkahTotpTerakhir]).toBe(0);
  });

  it("wrong totp is uniform 401 and has its own lockout (5 tries, then even the right code is refused)", async () => {
    const secret = generateTotpSecret();
    await seedAccount({ id: "recPIC000000001A", email: "pic@x.id", peran: "PIC Paroki", mfaSecret: secret });
    for (let i = 0; i < 5; i++) {
      const r = await login(req({ email: "pic@x.id", password: PASSWORD, totp: "000000" }));
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "Email atau password salah" });
      await settle();
    }
    const good = generateSync({ secret, epoch: Date.now() / 1000 });
    expect((await login(req({ email: "pic@x.id", password: PASSWORD, totp: good }))).status).toBe(429);
  });

  it("a correct password with a pending MFA step does not reset the failure count", async () => {
    const secret = generateTotpSecret();
    await seedAccount({ id: "recPIC000000001A", email: "pic@x.id", peran: "PIC Paroki", mfaSecret: secret });
    await login(req({ email: "pic@x.id", password: PASSWORD, totp: "000000" }));
    await login(req({ email: "pic@x.id", password: PASSWORD }));
    await settle();
    expect(row("recPIC000000001A").fields[A.gagalLogin]).toBe(1);
  });

  it("SEP without a secret must enroll; enrollment verifies a code, stores it encrypted, and logs in", async () => {
    await seedAccount({ id: "recSEP000000001A", email: "sep@x.id", peran: "SEP" });
    const r1 = await login(req({ email: "sep@x.id", password: PASSWORD }));
    expect(await r1.json()).toEqual({ next: "mfa_enroll" });
    expect(setCookies(r1).some((c) => c.startsWith("__Host-kep_session=") && !c.includes("Max-Age=0"))).toBe(false);
    const pre = cookieHeaderFrom(r1);
    expect(setCookies(r1).find((c) => c.startsWith("__Secure-kep_preauth="))).toMatch(/Path=\/api\/auth\/mfa\/enroll/);

    const s = await (await enroll(req({}, pre))).json();
    expect(s.otpauthUri).toContain("otpauth://totp/");
    // unauthenticated enrollment refused
    expect((await enroll(req({}))).status).toBe(401);

    const r2 = await enroll(req({}, pre));
    const s2 = await r2.json();
    const pre2 = cookieHeaderFrom(r2);
    expect((await enroll(req({ code: "000000" }, pre2))).status).toBe(400);
    const done = await enroll(req({ code: generateSync({ secret: s2.secret, epoch: Date.now() / 1000 }) }, pre2));
    expect(done.status).toBe(200);
    expect(setCookies(done).some((c) => c.startsWith("__Host-kep_session=") && c.includes("HttpOnly"))).toBe(true);
    const stored = row("recSEP000000001A").fields[A.rahasiaMfa] as string;
    expect(stored).not.toContain(s2.secret);
    expect(decryptSecret(stored)).toBe(s2.secret);
    // once enrolled, enrolling again is refused
    expect((await enroll(req({}, pre2))).status).toBe(409);
  });

  it("ADMIN logs in without MFA", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "a@x.id", peran: "Admin Paroki" });
    const r = await login(req({ email: "a@x.id", password: PASSWORD }));
    expect(r.status).toBe(200);
    expect((await r.json()).role).toBe("ADMIN");
    expect(setCookies(r).some((c) => c.startsWith("__Host-kep_session=") && c.includes("SameSite=Lax"))).toBe(true);
  });

  it("an ADMIN who has enrolled MFA must use it", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "a@x.id", peran: "Admin Paroki", mfaSecret: generateTotpSecret() });
    expect(await (await login(req({ email: "a@x.id", password: PASSWORD }))).json()).toEqual({ next: "mfa" });
  });
});

describe("logout and input", () => {
  it("logout clears the session cookie", async () => {
    const r = await logout(req({}));
    expect(setCookies(r).find((c) => c.startsWith("__Host-kep_session="))).toMatch(/Max-Age=0/);
  });
  it("malformed bodies are 400", async () => {
    expect((await login(req({ email: 1, password: "x" }))).status).toBe(400);
    expect((await login(new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: "nope" }))).status).toBe(400);
  });
});

async function preauthFor(email = "sep@x.id") {
  const r = await login(req({ email, password: PASSWORD }));
  expect(await r.json()).toEqual({ next: "mfa_enroll" });
  return cookieHeaderFrom(r);
}

describe("timing: failure write is off the response path", () => {
  it("a wrong password responds while the Airtable write is still pending, and the write still completes", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "a@x.id", peran: "Admin Paroki" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = vi.mocked(airtable.updateRecords).getMockImplementation()!;
    vi.mocked(airtable.updateRecords).mockImplementationOnce(async (...a) => {
      await gate;
      return real(...a);
    });
    const r = await login(req({ email: "a@x.id", password: "wrong-password-123" }));
    expect(r.status).toBe(401); // returned although the write is blocked
    expect(row("recADMIN00000001").fields[A.gagalLogin]).toBeUndefined();
    release();
    await settle();
    expect(row("recADMIN00000001").fields[A.gagalLogin]).toBe(1);
  });

  it("runs a dummy argon2 verify for unknown and locked accounts", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "a@x.id", peran: "Admin Paroki", fields: { [A.waktuKunci]: new Date(Date.now() + 600_000).toISOString() } });
    const spy = vi.mocked(pw.verifyPassword);
    spy.mockClear();
    await login(req({ email: "nobody@x.id", password: "whatever-whatever" }));
    await login(req({ email: "a@x.id", password: PASSWORD }));
    expect(spy).toHaveBeenCalledTimes(2);
    for (const c of spy.mock.calls) expect(c[0]).toMatch(/^\$argon2id\$/);
    expect(spy.mock.calls.every((c) => c[0] !== (row("recADMIN00000001").fields[A.hashPassword] as string))).toBe(true);
  });
});

describe("request guard and headers", () => {
  const raw = (headers: Record<string, string>) =>
    new Request("http://localhost/api/x", { method: "POST", headers, body: JSON.stringify({ email: "a@x.id", password: "x" }) });
  it.each([
    ["non-json content type", { "content-type": "text/plain", origin: "http://localhost" }, 415],
    ["no origin or fetch-metadata", { "content-type": "application/json" }, 403],
    ["cross-site Origin", { "content-type": "application/json", origin: "https://evil.example" }, 403],
    ["cross-site Sec-Fetch-Site", { "content-type": "application/json", "sec-fetch-site": "cross-site" }, 403],
  ])("login/enroll/logout reject %s", async (_n, h, status) => {
    for (const route of [login, enroll, logout]) {
      const r = await route(raw(h));
      expect(r.status).toBe(status);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.getSetCookie()).toEqual([]);
    }
  });
  it("accepts Origin alone or Sec-Fetch-Site alone when same-origin", async () => {
    expect((await login(raw({ "content-type": "application/json", origin: "http://localhost" }))).status).toBe(401);
    expect((await login(raw({ "content-type": "application/json", "sec-fetch-site": "same-origin" }))).status).toBe(401);
  });
  it("every auth response is no-store", async () => {
    await seedAccount({ id: "recSEP000000001A", email: "sep@x.id", peran: "SEP" });
    const pre = await login(req({ email: "sep@x.id", password: PASSWORD }));
    expect(pre.headers.get("cache-control")).toBe("no-store");
    const s1 = await enroll(req({}, cookieHeaderFrom(pre)));
    expect(s1.headers.get("cache-control")).toBe("no-store");
    expect((await login(req({ email: "x@x.id", password: "y" }))).headers.get("cache-control")).toBe("no-store");
    expect((await logout(req({}))).headers.get("cache-control")).toBe("no-store");
  });
});

describe("rate limiting", () => {
  it("per-account limit: 11th attempt in the window is 429 with Retry-After, even for unknown emails", async () => {
    let last!: Response;
    for (let i = 0; i < 11; i++) last = await login(req({ email: "ghost@x.id", password: "wrong-password-123" }));
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("per-IP limit applies across different emails", async () => {
    let last!: Response;
    for (let i = 0; i < 61; i++) {
      last = await login(new Request("http://localhost/api/x", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost", "x-real-ip": "203.0.113.9" },
        body: JSON.stringify({ email: `u${i}@x.id`, password: "wrong-password-123" }),
      }));
    }
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBeTruthy();
  });
  it("fails CLOSED when Upstash errors", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://upstash.local");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    try {
      const r = await login(req({ email: "a@x.id", password: PASSWORD }));
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("uses Upstash atomic INCR when configured", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://upstash.local");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t");
    const f = vi.fn(async (..._a: unknown[]) => Response.json([{ result: 1 }, { result: 1 }, { result: 900 }]));
    vi.stubGlobal("fetch", f);
    try {
      await seedAccount({ id: "recADMIN00000001", email: "a@x.id", peran: "Admin Paroki" });
      expect((await login(req({ email: "a@x.id", password: PASSWORD }))).status).toBe(200);
      expect(f).toHaveBeenCalled();
      expect(String(f.mock.calls[0][0])).toBe("http://upstash.local/pipeline");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("enroll is limited per account", async () => {
    await seedAccount({ id: "recSEP000000001A", email: "sep@x.id", peran: "SEP" });
    const pre = await preauthFor();
    let last!: Response;
    for (let i = 0; i < 11; i++) last = await enroll(req({}, pre));
    expect(last.status).toBe(429);
  });
});

describe("misconfiguration", () => {
  it("a rotated MFA_ENC_KEY gives 500 with no detail and no lockout counting", async () => {
    await seedAccount({ id: "recPIC000000001A", email: "pic@x.id", peran: "PIC Paroki", mfaSecret: generateTotpSecret() });
    vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
    const r = await login(req({ email: "pic@x.id", password: PASSWORD, totp: "123456" }));
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(JSON.stringify(body)).not.toMatch(/key|decrypt|MFA_ENC/i);
    await settle();
    expect(row("recPIC000000001A").fields[A.gagalLogin]).toBeUndefined();
  });
});

describe("enrollment hardening", () => {
  it("pre-auth cannot be extended by step-1 refreshes: refused after 5 minutes from first issue", async () => {
    await seedAccount({ id: "recSEP000000001A", email: "sep@x.id", peran: "SEP" });
    const pre = await preauthFor();
    vi.setSystemTime(Date.now() + 4 * 60_000);
    const r = await enroll(req({}, pre));
    expect(r.status).toBe(200);
    const refreshed = cookieHeaderFrom(r);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect((await enroll(req({}, refreshed))).status).toBe(401);
  });

  it("pre-auth is void once the password changes", async () => {
    await seedAccount({ id: "recSEP000000001A", email: "sep@x.id", peran: "SEP" });
    const pre = await preauthFor();
    row("recSEP000000001A").fields[A.hashPassword] = "$argon2id$changed";
    expect((await enroll(req({}, pre))).status).toBe(401);
  });

  it("a locked account gets 429 on enroll", async () => {
    await seedAccount({ id: "recSEP000000001A", email: "sep@x.id", peran: "SEP" });
    const pre = await preauthFor();
    row("recSEP000000001A").fields[A.waktuKunci] = new Date(Date.now() + 600_000).toISOString();
    const r = await enroll(req({}, pre));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("completion is refused if an MFA secret appeared meanwhile, and parallel completions yield one winner", async () => {
    await seedAccount({ id: "recSEP000000001A", email: "sep@x.id", peran: "SEP" });
    const pre = await preauthFor();
    const s = await enroll(req({}, pre));
    const { secret } = await s.json();
    const withPending = cookieHeaderFrom(s);
    const code = generateSync({ secret, epoch: Date.now() / 1000 });
    const results = await Promise.all([enroll(req({ code }, withPending)), enroll(req({ code }, withPending))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    await seedAccount({ id: "recSEP000000002A", email: "sep2@x.id", peran: "SEP" });
    const pre2 = await preauthFor("sep2@x.id");
    const s2 = await enroll(req({}, pre2));
    const { secret: sec2 } = await s2.json();
    row("recSEP000000002A").fields[A.rahasiaMfa] = "something";
    const r = await enroll(req({ code: generateSync({ secret: sec2, epoch: Date.now() / 1000 }) }, cookieHeaderFrom(s2)));
    expect(r.status).toBe(409);
  });

  it("a bad MFA_ENC_KEY during enrollment is a 500 without detail", async () => {
    await seedAccount({ id: "recSEP000000001A", email: "sep@x.id", peran: "SEP" });
    const pre = await preauthFor();
    vi.stubEnv("MFA_ENC_KEY", "bad");
    const r = await enroll(req({}, pre));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toMatch(/key|MFA_ENC/i);
  });
});
