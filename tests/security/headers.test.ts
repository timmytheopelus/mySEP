import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { buildCsp } from "../../src/lib/csp";

async function globalHeaders() {
  const rules = await nextConfig.headers!();
  const rule = rules.find((r) => r.source === "/:path*");
  expect(rule).toBeDefined();
  return Object.fromEntries(rule!.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

describe("security headers (next.config headers())", () => {
  it("sets HSTS, nosniff, referrer policy, frame protection", async () => {
    const h = await globalHeaders();
    expect(h["strict-transport-security"]).toMatch(/max-age=\d{8,}/);
    expect(h["strict-transport-security"]).toContain("includeSubDomains");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBeTruthy();
    expect(h["permissions-policy"]).toBeTruthy();
  });
});

describe("Content-Security-Policy", () => {
  const csp = buildCsp("abc123", false);
  it("forbids unsafe-eval and (in production) unsafe-inline scripts", () => {
    expect(csp).not.toContain("unsafe-eval");
    const script = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src"))!;
    expect(script).not.toContain("unsafe-inline");
    expect(script).toContain("'nonce-abc123'");
  });
  it("restricts frame-src to youtube-nocookie and Turnstile", () => {
    const frame = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("frame-src"))!;
    expect(frame).toBe("frame-src https://www.youtube-nocookie.com https://challenges.cloudflare.com");
  });
  it("allows data: images only (TOTP QR code) and nowhere else", () => {
    const dir = (n: string) => csp.split(";").map((x) => x.trim()).find((x) => x.startsWith(n))!;
    expect(dir("img-src")).toContain("data:");
    for (const n of ["default-src", "script-src", "style-src", "connect-src", "frame-src", "object-src"]) {
      expect(dir(n)).not.toContain("data:");
    }
    expect(csp).not.toMatch(/(^|;)\s*img-src[^;]*\*/);
  });
  it("locks down object-src, base-uri, frame-ancestors", () => {
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
