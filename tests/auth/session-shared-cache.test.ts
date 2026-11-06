import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

// The production build bundles route handlers and server pages as separate copies of lib/auth/session.ts in ONE
// process. This test loads two real module instances and checks that they share the account cache.
type Mod = typeof import("@/lib/auth/session");
const sess = { accountId: "recAAAAAAAAAAAA", email: "pic@x.id", role: "PIC" as const, parokiId: "recPAROKI0000001" };
const cookie = (m: Mod, t: string) => `${m.SESSION_COOKIE}=${t}`;

async function twoInstances(): Promise<[Mod, Mod]> {
  vi.resetModules();
  const api = await import("@/lib/auth/session");
  vi.resetModules();
  const page = await import("@/lib/auth/session");
  expect(page).not.toBe(api); // really two copies
  return [api, page];
}

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "x".repeat(40));
  resetStore();
  await seedAccount({ id: sess.accountId, email: sess.email, peran: "PIC Paroki", fields: { [F.akunKep.paroki]: [sess.parokiId] } });
});
afterEach(() => vi.unstubAllEnvs());

describe("account cache is shared by every module instance of the process", () => {
  it("invalidateAccount in the API copy takes effect in the page copy at once (deactivation)", async () => {
    const [api, page] = await twoInstances();
    api.clearSessionCache();
    const token = await api.issueSession(sess, { amr: ["pwd", "otp"] });
    expect((await page.readSession(cookie(page, token)))?.accountId).toBe(sess.accountId); // page copy caches the live account
    const row = store[T.akunKep].find((r) => r.id === sess.accountId)!;
    row.fields[F.akunKep.statusAktif] = false;
    // still cached: the page keeps serving until the API side invalidates
    expect(await page.readSession(cookie(page, token))).not.toBeNull();
    api.invalidateAccount(sess.accountId); // what manage.ts does in the API bundle
    expect(await page.readSession(cookie(page, token))).toBeNull();
  });

  it("clearSessionCache of one copy clears the other, and a read in one copy is a cache hit in the other", async () => {
    const [api, page] = await twoInstances();
    api.clearSessionCache();
    const token = await api.issueSession(sess, { amr: ["pwd", "otp"] });
    await api.readSession(cookie(api, token));
    store[T.akunKep].find((r) => r.id === sess.accountId)!.fields[F.akunKep.statusAktif] = false;
    expect(await page.readSession(cookie(page, token))).not.toBeNull(); // shared cache hit: the change is not seen yet
    store[T.akunKep].find((r) => r.id === sess.accountId)!.fields[F.akunKep.statusAktif] = true;
    page.clearSessionCache();
    const row = store[T.akunKep].find((r) => r.id === sess.accountId)!;
    row.fields[F.akunKep.statusAktif] = false;
    expect(await api.readSession(cookie(api, token))).toBeNull();
  });
});
