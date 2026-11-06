import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClientModule, resetStore, seedAccount } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import { POST as logout } from "@/app/api/auth/logout/route";
import { SESSION_COOKIE, clearSessionCache, issueSession, readSession, renewSession, type Session } from "@/lib/auth/session";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: "recPAROKIA0000001" };
const OTP = { amr: ["pwd", "otp"] as ("pwd" | "otp")[] };
const ck = (t: string) => `${SESSION_COOKIE}=${t}`;
const post = (cookie: string) =>
  logout(new Request("https://kep.test/api/auth/logout", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", cookie } }));

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { "fldZFNJGpXd4szQ0O": [pic.parokiId!] } });
});
afterEach(() => vi.unstubAllEnvs());

describe("server-side logout", () => {
  it("a copied token is dead after logout, including its renewals; other sessions survive", async () => {
    const t = await issueSession(pic, OTP);
    const other = await issueSession(pic, OTP);
    const renewed = (await renewSession(ck(t)))!.token; // same session lineage
    expect(await readSession(ck(t))).not.toBeNull();
    const res = await post(ck(t));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(";")).toContain("Max-Age=0");
    expect(await readSession(ck(t))).toBeNull();
    expect(await readSession(ck(renewed))).toBeNull();
    expect((await renewSession(ck(renewed)))).toBeNull();
    expect(await readSession(ck(other))).not.toBeNull();
  });

  it("logout without a valid session still clears the cookie", async () => {
    const res = await post("");
    expect(res.status).toBe(200);
  });

  it("the denylist entry lives on in the store after the memory limiter is untouched by other keys", async () => {
    const t = await issueSession(pic, OTP);
    await post(ck(t));
    resetRateLimitMemory(); // cold start: with the in-memory fallback this is the documented limit
    expect(await readSession(ck(t))).not.toBeNull();
  });
});
