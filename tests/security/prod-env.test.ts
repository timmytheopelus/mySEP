import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { productionConfigProblems } from "@/lib/config/prodEnv";
import { isKeyRevoked, rateLimit, resetRateLimitMemory, revokeKey } from "@/lib/ratelimit";
import { proxy } from "@/proxy";

const GOOD = {
  NODE_ENV: "production",
  SESSION_SECRET: "s".repeat(40),
  MFA_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
  REG_TOKEN_SECRET: "r".repeat(40),
  AIRTABLE_TOKEN: "patX",
  APP_BASE_URL: "https://kep.example.org",
  UPSTASH_REDIS_REST_URL: "https://up.example",
  UPSTASH_REDIS_REST_TOKEN: "t",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("productionConfigProblems", () => {
  it("is empty outside production", () => expect(productionConfigProblems({ NODE_ENV: "development" })).toEqual([]));
  it("is empty for a complete production config", () => expect(productionConfigProblems(GOOD)).toEqual([]));
  it("names every missing required setting (never values)", () => {
    const p = productionConfigProblems({ NODE_ENV: "production" }).join("\n");
    for (const n of ["SESSION_SECRET", "MFA_ENC_KEY", "REG_TOKEN_SECRET", "AIRTABLE_TOKEN", "APP_BASE_URL", "UPSTASH_REDIS_REST_URL"]) expect(p).toContain(n);
  });
  it("refuses short or malformed secrets", () => {
    const p = productionConfigProblems({ ...GOOD, SESSION_SECRET: "short", MFA_ENC_KEY: "abc", REG_TOKEN_SECRET: "x" }).join("\n");
    expect(p).toContain("SESSION_SECRET");
    expect(p).toContain("MFA_ENC_KEY");
    expect(p).toContain("REG_TOKEN_SECRET");
    expect(p).not.toContain("short");
  });
  it("refuses the AIRTABLE_API_URL override in production", () => {
    expect(productionConfigProblems({ ...GOOD, AIRTABLE_API_URL: "https://evil.example/v0" }).join()).toContain("AIRTABLE_API_URL");
  });
  it("refuses a non-https or non-origin APP_BASE_URL and a GOOGLE_REDIRECT_BASE on another origin", () => {
    expect(productionConfigProblems({ ...GOOD, APP_BASE_URL: "http://kep.example.org" }).join()).toContain("APP_BASE_URL");
    expect(productionConfigProblems({ ...GOOD, APP_BASE_URL: "https://kep.example.org/app" }).join()).toContain("APP_BASE_URL");
    expect(productionConfigProblems({ ...GOOD, GOOGLE_REDIRECT_BASE: "https://other.example.org" }).join()).toContain("GOOGLE_REDIRECT_BASE");
    expect(productionConfigProblems({ ...GOOD, GOOGLE_REDIRECT_BASE: "https://kep.example.org" })).toEqual([]);
  });
  it("KEP_E2E_MODE relaxes Upstash/API URL/localhost only off Vercel", () => {
    const e2e = { ...GOOD, UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", AIRTABLE_API_URL: "http://127.0.0.1:4010", APP_BASE_URL: "http://localhost:3000", KEP_E2E_MODE: "1" };
    expect(productionConfigProblems(e2e)).toEqual([]);
    const onVercel = productionConfigProblems({ ...e2e, VERCEL: "1" }).join("\n");
    expect(onVercel).toContain("UPSTASH");
    expect(onVercel).toContain("AIRTABLE_API_URL");
    expect(onVercel).toContain("APP_BASE_URL");
  });
});

describe("proxy refuses to serve a misconfigured production deployment", () => {
  it("503 for every request when production config is incomplete", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    for (const k of Object.keys(GOOD)) if (k !== "NODE_ENV") vi.stubEnv(k, "");
    const res = proxy(new NextRequest("https://kep.example.org/api/kep"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("passes through when complete", () => {
    for (const [k, v] of Object.entries(GOOD)) vi.stubEnv(k, v);
    const res = proxy(new NextRequest("https://kep.example.org/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("nonce-");
  });
});

describe("production never falls back to per-process memory", () => {
  beforeEach(() => {
    resetRateLimitMemory();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  it("rateLimit denies (fail closed), even with failClosed:false", async () => {
    expect((await rateLimit("k", 100, 60)).ok).toBe(false);
    expect((await rateLimit("k", 100, 60, { failClosed: false })).ok).toBe(false);
  });
  it("the session denylist treats every session as revoked and refuses writes", async () => {
    expect(await isKeyRevoked("x")).toBe(true);
    expect(await revokeKey("x", 60)).toBe(false);
  });
  it("development keeps the memory fallback", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await rateLimit("k2", 1, 60)).ok).toBe(true);
    expect((await rateLimit("k2", 1, 60)).ok).toBe(false);
    expect(await isKeyRevoked("y")).toBe(false);
    expect(await revokeKey("y", 60)).toBe(true);
    expect(await isKeyRevoked("y")).toBe(true);
  });
});

describe("Upstash response handling", () => {
  beforeEach(() => {
    resetRateLimitMemory();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://up.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t");
  });
  const stub = (...bodies: unknown[]) => {
    const f = vi.fn<(u: string, i: RequestInit) => Promise<Response>>();
    for (const b of bodies) f.mockResolvedValueOnce(Response.json(b));
    vi.stubGlobal("fetch", f);
    return f;
  };
  const cmds = (f: ReturnType<typeof stub>, i: number) => JSON.parse(String(f.mock.calls[i][1].body));

  it("EXPIRE error in the pipeline triggers a repair EXPIRE; window is enforced", async () => {
    const f = stub([{ result: 1 }, { error: "ERR syntax" }, { result: -1 }], [{ result: 1 }]);
    const r = await rateLimit("k", 5, 60);
    expect(r).toEqual({ ok: true, retryAfter: 60 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(cmds(f, 1)).toEqual([["EXPIRE", "k", 60]]);
  });
  it("TTL -1 (key without expiry) is repaired, not allowed forever", async () => {
    const f = stub([{ result: 3 }, { result: 0 }, { result: -1 }], [{ result: 1 }]);
    expect((await rateLimit("k", 5, 60)).ok).toBe(true);
    expect(cmds(f, 1)).toEqual([["EXPIRE", "k", 60]]);
  });
  it("a failed repair fails closed", async () => {
    stub([{ result: 1 }, { result: 0 }, { result: -1 }], [{ error: "down" }]);
    expect((await rateLimit("k", 5, 60)).ok).toBe(false);
  });
  it("a TTL error fails closed unless repaired", async () => {
    stub([{ result: 1 }, { result: 1 }, { error: "x" }], [{ result: 0 }]);
    expect((await rateLimit("k", 5, 60)).ok).toBe(false);
  });
  it("isKeyRevoked fails closed on malformed 200 bodies", async () => {
    for (const body of [{}, [], "x", null, [null], [{ error: "e" }]]) {
      stub(body);
      expect(await isKeyRevoked("j")).toBe(true);
    }
    stub([{ result: null }]);
    expect(await isKeyRevoked("j")).toBe(false);
    stub([{ result: "1" }]);
    expect(await isKeyRevoked("j")).toBe(true);
  });
  it("revokeKey checks the per-command result", async () => {
    stub([{ error: "OOM" }]);
    expect(await revokeKey("j", 60)).toBe(false);
    stub({ nope: 1 });
    expect(await revokeKey("j", 60)).toBe(false);
    stub([{ result: "OK" }]);
    expect(await revokeKey("j", 60)).toBe(true);
  });
});
