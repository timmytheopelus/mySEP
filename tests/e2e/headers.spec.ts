import { expect, test } from "@playwright/test";

test("GET / returns security headers", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["strict-transport-security"]).toContain("max-age=");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBeTruthy();
  const csp = h["content-security-policy"];
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).toContain("frame-src https://www.youtube-nocookie.com https://challenges.cloudflare.com");
});
