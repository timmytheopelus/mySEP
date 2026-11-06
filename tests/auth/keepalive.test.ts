import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { F } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
let cookieHeader = "";
vi.mock("next/headers", () => ({ cookies: async () => ({ toString: () => cookieHeader }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`REDIRECT ${to}`), { to });
  },
}));

import { decodeJwt } from "jose";
import { GET as ping } from "@/app/api/sesi/ping/route";
import { startKeepAlive } from "@/app/(app)/_components/SessionKeepAlive";
import { GET_LIMIT } from "@/lib/auth/guard";
import { pageSession } from "@/lib/auth/page";
import { SESSION_COOKIE, SESSION_MAX_S, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const PA = "recPAROKIA0000001";
const pic: Session = { accountId: "recPICA0000000001", email: "pica@x.id", role: "PIC", parokiId: PA };
const OTP = { amr: ["pwd", "otp"] as ("pwd" | "otp")[] };
const ck = async (o: Parameters<typeof issueSession>[1] = OTP) => `${SESSION_COOKIE}=${await issueSession(pic, o)}`;
const get = async (cookie?: string) => ping(new Request("https://kep.test/api/sesi/ping", { headers: cookie ? { cookie } : {} }), { params: Promise.resolve({}) });

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "x".repeat(40));
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [F.akunKep.paroki]: [PA] } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/sesi/ping (final fix I3)", () => {
  it("401 without a session; 200 + renewed sliding cookie with one", async () => {
    expect((await get()).status).toBe(401);
    const res = await get(await ck());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(set).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("never extends the 8 h absolute cap; after the cap it is 401", async () => {
    const startedAt = Math.floor(Date.now() / 1000) - SESSION_MAX_S + 60; // 1 minute left
    const res = await get(await ck({ ...OTP, startedAt }));
    const token = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0].split("=")[1];
    expect(decodeJwt(token).exp).toBeLessThanOrEqual(startedAt + SESSION_MAX_S);
    const late = await ck({ ...OTP, startedAt: Math.floor(Date.now() / 1000) - SESSION_MAX_S - 1 });
    expect((await get(late)).status).toBe(401);
  });
  it("shares the per-account GET budget (600 / 10 min)", async () => {
    const c = await ck();
    for (let i = 0; i < GET_LIMIT; i++) await get(c);
    expect((await get(c)).status).toBe(429);
  });
});

describe("pageSession: server pages share the GET budget", () => {
  it("redirects to /login without a session, to /batas once the budget is spent", async () => {
    cookieHeader = "";
    await expect(pageSession()).rejects.toMatchObject({ to: "/login" });
    cookieHeader = await ck();
    expect(await pageSession()).toEqual(pic);
    for (let i = 0; i < GET_LIMIT - 1; i++) await get(cookieHeader);
    await expect(pageSession()).rejects.toMatchObject({ to: "/batas" });
  });
});

describe("startKeepAlive (client)", () => {
  function fakeWindow(status = 200) {
    const listeners = new Map<string, () => void>();
    const w = {
      document: { visibilityState: "visible" as string },
      location: { replace: vi.fn() },
      fetch: vi.fn(async () => new Response("{}", { status })),
      addEventListener: (e: string, f: () => void) => listeners.set(e, f),
      removeEventListener: (e: string) => listeners.delete(e),
      setInterval: (f: () => void, ms: number) => setInterval(f, ms),
      clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
    };
    return { w, fire: (e: string) => listeners.get(e)?.(), listeners };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it("pings every 5 minutes only while visible and recently active", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { w, fire } = fakeWindow();
    const stop = startKeepAlive(w as never);
    vi.advanceTimersByTime(5 * 60_000); // activity at start counts
    await flush();
    expect(w.fetch).toHaveBeenCalledTimes(1);
    expect(w.fetch).toHaveBeenCalledWith("/api/sesi/ping", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
    vi.advanceTimersByTime(5 * 60_000 + 1); // no activity for > 5 min: idle, no ping (the session may expire)
    await flush();
    expect(w.fetch).toHaveBeenCalledTimes(1);
    fire("keydown");
    w.document.visibilityState = "hidden";
    vi.advanceTimersByTime(5 * 60_000);
    await flush();
    expect(w.fetch).toHaveBeenCalledTimes(1); // hidden tab: no ping
    w.document.visibilityState = "visible";
    fire("pointerdown");
    vi.advanceTimersByTime(5 * 60_000);
    await flush();
    expect(w.fetch).toHaveBeenCalledTimes(2);
    stop();
  });
  it("stops on 401 and sends the user to /login with a message", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { w, listeners } = fakeWindow(401);
    startKeepAlive(w as never);
    vi.advanceTimersByTime(5 * 60_000);
    await flush();
    expect(w.location.replace).toHaveBeenCalledWith("/login?sesi=habis");
    expect(listeners.size).toBe(0);
    vi.advanceTimersByTime(30 * 60_000);
    await flush();
    expect(w.fetch).toHaveBeenCalledTimes(1);
  });
});
