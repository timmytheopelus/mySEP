import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BreachCheckUnavailableError,
  hashPassword,
  isBreachedPassword,
  validatePasswordPolicy,
  verifyPassword,
} from "@/lib/auth/password";

afterEach(() => vi.unstubAllGlobals());

describe("validatePasswordPolicy", () => {
  it("rejects 11 characters", () => {
    const r = validatePasswordPolicy("a".repeat(11));
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  it("accepts 12 characters", () => {
    expect(validatePasswordPolicy("a".repeat(12))).toEqual({ ok: true });
  });
});

describe("hash/verify", () => {
  it("produces Argon2id hashes that differ per call and verify correctly", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(a, "correct horse battery")).toBe(true);
    expect(await verifyPassword(a, "wrong horse battery!")).toBe(false);
  });
  it("returns false (no throw) for a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "whatever-password")).toBe(false);
  });
});

describe("isBreachedPassword (fetch stubbed)", () => {
  const pw = "password1234";
  const sha = createHash("sha1").update(pw).digest("hex").toUpperCase();

  it("returns true on suffix match and sends only the 5-char prefix", async () => {
    const fetchMock = vi.fn(async () => new Response(`ABCDEF:1\r\n${sha.slice(5)}:42\r\n`));
    vi.stubGlobal("fetch", fetchMock);
    expect(await isBreachedPassword(pw)).toBe(true);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`);
    expect(url).not.toContain(sha.slice(5));
  });
  it("returns false when no suffix matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ABCDEF:1\r\n")));
    expect(await isBreachedPassword(pw)).toBe(false);
  });
  it("throws a retry error when the service fails (non-ok)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(isBreachedPassword(pw)).rejects.toBeInstanceOf(BreachCheckUnavailableError);
  });
  it("throws a retry error when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(isBreachedPassword(pw)).rejects.toThrow(/coba lagi/i);
  });
});
