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
  it("accepts current and adjacent codes, rejects 3 steps old and garbage", () => {
    const secret = generateTotpSecret();
    const now = Math.floor(Date.now() / 1000);
    const at = (e: number) => generateSync({ secret, epoch: e });
    expect(verifyTotp(secret, at(now))).toBe(true);
    expect(verifyTotp(secret, at(now - 30))).toBe(true);
    expect(verifyTotp(secret, at(now + 30))).toBe(true);
    expect(verifyTotp(secret, at(now - 90))).toBe(false);
    expect(verifyTotp(secret, "abcdef")).toBe(false);
    expect(verifyTotp(secret, "")).toBe(false);
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
  it("throws if the key is missing or not 32 bytes", () => {
    vi.stubEnv("MFA_ENC_KEY", "");
    expect(() => encryptSecret("x")).toThrow(/MFA_ENC_KEY/);
    vi.stubEnv("MFA_ENC_KEY", Buffer.alloc(16).toString("base64"));
    expect(() => encryptSecret("x")).toThrow(/MFA_ENC_KEY/);
  });
});
