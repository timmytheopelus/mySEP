import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { generateSync } from "otplib";
import { F, T } from "@/lib/airtable/schema";
import { PASSWORD, fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import { POST as login } from "@/app/api/auth/login/route";
import { POST as enroll } from "@/app/api/auth/mfa/enroll/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { clearSessionCache, readSession } from "@/lib/auth/session";
import { generateTotpSecret, decryptSecret } from "@/lib/auth/totp";

const A = F.akunKep;
const req = (body: unknown, cookie = "") =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const row = (id: string) => store[T.akunKep].find((r) => r.id === id)!;
const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieHeaderFrom = (res: Response) => setCookies(res).map((c) => c.split(";")[0]).join("; ");
let clockEpoch = 1_800_000_015;

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  resetStore();
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
    expect(setCookies(r).some((c) => c.startsWith("kep_session=") && !c.includes("Max-Age=0"))).toBe(false);
  });

  it("PIC with a correct totp gets a hardened kep_session cookie; step persisted, replay rejected", async () => {
    const secret = generateTotpSecret();
    await seedAccount({ id: "recPIC000000001A", email: "pic@x.id", peran: "PIC Paroki", mfaSecret: secret });
    const code = generateSync({ secret, epoch: Date.now() / 1000 });
    const r = await login(req({ email: "pic@x.id", password: PASSWORD, totp: code }));
    expect(r.status).toBe(200);
    const c = setCookies(r).find((x) => x.startsWith("kep_session="))!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
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
    }
    const good = generateSync({ secret, epoch: Date.now() / 1000 });
    expect((await login(req({ email: "pic@x.id", password: PASSWORD, totp: good }))).status).toBe(401);
  });

  it("a correct password with a pending MFA step does not reset the failure count", async () => {
    const secret = generateTotpSecret();
    await seedAccount({ id: "recPIC000000001A", email: "pic@x.id", peran: "PIC Paroki", mfaSecret: secret });
    await login(req({ email: "pic@x.id", password: PASSWORD, totp: "000000" }));
    await login(req({ email: "pic@x.id", password: PASSWORD }));
    expect(row("recPIC000000001A").fields[A.gagalLogin]).toBe(1);
  });

  it("SEP without a secret must enroll; enrollment verifies a code, stores it encrypted, and logs in", async () => {
    await seedAccount({ id: "recSEP000000001A", email: "sep@x.id", peran: "SEP" });
    const r1 = await login(req({ email: "sep@x.id", password: PASSWORD }));
    expect(await r1.json()).toEqual({ next: "mfa_enroll" });
    expect(setCookies(r1).some((c) => c.startsWith("kep_session=") && !c.includes("Max-Age=0"))).toBe(false);
    const pre = cookieHeaderFrom(r1);

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
    expect(setCookies(done).some((c) => c.startsWith("kep_session=") && c.includes("HttpOnly"))).toBe(true);
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
    expect(setCookies(r).some((c) => c.startsWith("kep_session=") && c.includes("SameSite=Lax"))).toBe(true);
  });

  it("an ADMIN who has enrolled MFA must use it", async () => {
    await seedAccount({ id: "recADMIN00000001", email: "a@x.id", peran: "Admin Paroki", mfaSecret: generateTotpSecret() });
    expect(await (await login(req({ email: "a@x.id", password: PASSWORD }))).json()).toEqual({ next: "mfa" });
  });
});

describe("logout and input", () => {
  it("logout clears the session cookie", async () => {
    const r = await logout();
    expect(setCookies(r).find((c) => c.startsWith("kep_session="))).toMatch(/Max-Age=0/);
  });
  it("malformed bodies are 400", async () => {
    expect((await login(req({ email: 1, password: "x" }))).status).toBe(400);
    expect((await login(new Request("http://l/x", { method: "POST", body: "nope" }))).status).toBe(400);
  });
});
