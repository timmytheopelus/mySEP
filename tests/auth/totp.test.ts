import { generateSync } from "otplib";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, generateTotpSecret, verifyTotp } from "@/lib/auth/totp";

describe("totp", () => {
  afterEach(() => vi.useRealTimers());

  it("generates distinct base32 secrets", () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{16,}$/);
    expect(generateTotpSecret()).not.toBe(a);
  });
  it("accepts current and adjacent codes, rejects 3 steps old and garbage (fixed clock)", () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_015; // mid-step, so +-30 is exactly +-1 step
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const at = (e: number) => generateSync({ secret, epoch: e });
    expect(verifyTotp(secret, at(now))).toBe(Math.floor(now / 30));
    expect(verifyTotp(secret, at(now - 30))).toBe(Math.floor(now / 30) - 1);
    expect(verifyTotp(secret, at(now + 30))).toBe(Math.floor(now / 30) + 1);
    expect(verifyTotp(secret, at(now - 90))).toBeNull();
    expect(verifyTotp(secret, "abcdef")).toBeNull();
    expect(verifyTotp(secret, "")).toBeNull();
  });
  it("rejects replay: a step <= lastUsedStep is refused, a newer one accepted", () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_015;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const code = generateSync({ secret, epoch: now });
    const step = verifyTotp(secret, code);
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, step)).toBeNull();
    expect(verifyTotp(secret, generateSync({ secret, epoch: now - 30 }), step)).toBeNull();
    expect(verifyTotp(secret, generateSync({ secret, epoch: now + 30 }), step)).toBe(step! + 1);
  });
});

describe("encryptSecret/decryptSecret", () => {
  beforeEach(() => vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64")));
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips and randomises the blob", () => {
    const blob = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(blob).not.toContain("JBSWY3DP");
    expect(decryptSecret(blob)).toBe("JBSWY3DPEHPK3PXP");
    expect(encryptSecret("JBSWY3DPEHPK3PXP")).not.toBe(blob);
  });
  it("throws when any byte of the blob is altered", () => {
    const buf = Buffer.from(encryptSecret("JBSWY3DPEHPK3PXP"), "base64");
    for (const i of [0, 12, buf.length - 1]) {
      const bad = Buffer.from(buf);
      bad[i] ^= 1;
      expect(() => decryptSecret(bad.toString("base64"))).toThrow();
    }
  });
  it("throws with a wrong key", () => {
    const blob = encryptSecret("x");
    vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
    expect(() => decryptSecret(blob)).toThrow();
  });
  it("rejects a key with stray characters even if it decodes to 32 bytes", () => {
    const good = randomBytes(32).toString("base64");
    vi.stubEnv("MFA_ENC_KEY", good.slice(0, 10) + "!" + good.slice(10));
    expect(() => encryptSecret("x")).toThrow(/MFA_ENC_KEY/);
  });
  it("throws if the key is missing or not 32 bytes", () => {
    vi.stubEnv("MFA_ENC_KEY", "");
    expect(() => encryptSecret("x")).toThrow(/MFA_ENC_KEY/);
    vi.stubEnv("MFA_ENC_KEY", Buffer.alloc(16).toString("base64"));
    expect(() => encryptSecret("x")).toThrow(/MFA_ENC_KEY/);
  });
});
