import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import {
  SESSION_COOKIE,
  issuePreauth,
  readPreauth,
  PREAUTH_COOKIE,
  clearSessionCache,
  issueSession,
  readSession,
  renewSession,
} from "@/lib/auth/session";

const SECRET = "x".repeat(40);
const cookie = (t: string) => `${SESSION_COOKIE}=${t}`;
const OTP = { amr: ["pwd", "otp"] as ("pwd" | "otp")[] };
const sess = { accountId: "recAAAAAAAAAAAA", email: "pic@x.id", role: "PIC" as const, parokiId: "recPAROKI0000001" };

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  resetStore();
  clearSessionCache();
  await seedAccount({ id: sess.accountId, email: sess.email, peran: "PIC Paroki", fields: { [F.akunKep.paroki]: [sess.parokiId] } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("session", () => {
  it("round-trips a session from a valid cookie", async () => {
    const t = await issueSession(sess, OTP);
    expect(await readSession(cookie(t))).toEqual(sess);
  });

  it("rejects a JWT signed with the wrong key, alg none, and garbage", async () => {
    const forged = await new SignJWT({ email: sess.email, role: "SEP", sa: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sess.accountId)
      .setIssuer("kep").setAudience("kep-session")
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode("y".repeat(40)));
    expect(await readSession(cookie(forged))).toBeNull();
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: sess.accountId, aud: "kep-session", sa: 1 })).toString("base64url")}.`;
    expect(await readSession(cookie(none))).toBeNull();
    expect(await readSession(cookie("garbage"))).toBeNull();
    expect(await readSession("")).toBeNull();
  });

  it("expires after 15 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
    const t = await issueSession(sess, OTP);
    vi.setSystemTime(new Date("2026-11-06T10:16:00Z"));
    expect(await readSession(cookie(t))).toBeNull();
  });

  it("slides on renew but never beyond 8 hours from the first login", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
    let t = await issueSession(sess, OTP);
    // renew every 10 minutes for 7h50m
    for (let i = 0; i < 47; i++) {
      vi.setSystemTime(new Date(Date.parse("2026-11-06T10:00:00Z") + (i + 1) * 10 * 60_000));
      const r = await renewSession(cookie(t));
      expect(r).not.toBeNull();
      t = r!.token;
    }
    // 17:50: still valid; at 18:01 (> 8h since login) the last token is dead although renewed at 17:50
    vi.setSystemTime(new Date("2026-11-06T17:59:00Z"));
    expect(await readSession(cookie(t))).not.toBeNull();
    vi.setSystemTime(new Date("2026-11-06T18:01:00Z"));
    expect(await readSession(cookie(t))).toBeNull();
    expect(await renewSession(cookie(t))).toBeNull();
  });

  it("deactivating the account revokes the session once the 60 s cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
    const t = await issueSession(sess, OTP);
    expect(await readSession(cookie(t))).not.toBeNull();
    store[T.akunKep][0].fields[F.akunKep.statusAktif] = false;
    vi.setSystemTime(new Date("2026-11-06T10:00:30Z"));
    expect(await readSession(cookie(t))).not.toBeNull(); // still cached
    vi.setSystemTime(new Date("2026-11-06T10:01:01Z"));
    expect(await readSession(cookie(t))).toBeNull();
  });

  it("takes role from the live account, not the token", async () => {
    const t = await issueSession({ ...sess, role: "SEP" }, OTP);
    expect((await readSession(cookie(t)))?.role).toBe("PIC");
  });

  it("rejects a PIC/SEP token minted without an otp factor, but accepts it for ADMIN", async () => {
    const t = await issueSession(sess, { amr: ["pwd"] });
    expect(await readSession(cookie(t))).toBeNull();
    store[T.akunKep][0].fields[F.akunKep.peran] = "Admin Paroki";
    clearSessionCache();
    expect(await readSession(cookie(t))).not.toBeNull();
  });

  it("promoting an MFA-less ADMIN session to PIC voids it (role is live)", async () => {
    store[T.akunKep][0].fields[F.akunKep.peran] = "Admin Paroki";
    const t = await issueSession({ ...sess, role: "ADMIN" }, { amr: ["pwd"] });
    expect(await readSession(cookie(t))).not.toBeNull();
    store[T.akunKep][0].fields[F.akunKep.peran] = "PIC Paroki";
    clearSessionCache();
    expect(await readSession(cookie(t))).toBeNull();
  });

  it("a pre-auth token is not a session, and a session is not pre-auth", async () => {
    const pre = await issuePreauth({ accountId: sess.accountId, passwordHash: "h" });
    expect(await readSession(`${SESSION_COOKIE}=${pre}`)).toBeNull();
    const ses = await issueSession(sess, OTP);
    expect(await readPreauth(`${PREAUTH_COOKIE}=${ses}`)).toBeNull();
    expect(await readPreauth(`${PREAUTH_COOKIE}=${pre}`)).not.toBeNull();
  });

  it("pre-auth re-issue keeps the original window: no extension past 5 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
    const first = await issuePreauth({ accountId: sess.accountId, passwordHash: "h" });
    const p1 = (await readPreauth(`${PREAUTH_COOKIE}=${first}`))!;
    vi.setSystemTime(new Date("2026-11-06T10:04:00Z"));
    const again = await issuePreauth({ accountId: sess.accountId, passwordHash: "h", pendingSecretEnc: "x", origIat: p1.origIat });
    vi.setSystemTime(new Date("2026-11-06T10:04:59Z"));
    expect(await readPreauth(`${PREAUTH_COOKIE}=${again}`)).not.toBeNull();
    vi.setSystemTime(new Date("2026-11-06T10:05:01Z"));
    expect(await readPreauth(`${PREAUTH_COOKIE}=${again}`)).toBeNull();
  });

  it("refuses to sign without a strong SESSION_SECRET", async () => {
    vi.stubEnv("SESSION_SECRET", "short");
    await expect(issueSession(sess, OTP)).rejects.toThrow(/SESSION_SECRET/);
  });
});
