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

// The nonce must be wired from the CSP header (src/proxy.ts) into every script Next renders; otherwise strict-dynamic
// blocks the app in production. Checks the request-time header against the DOM, and that no CSP violation fired.
for (const path of ["/", "/login"]) {
  test(`script tags on ${path} carry the nonce from the CSP header`, async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) violations.push(m.text());
    });
    const res = await page.goto(path);
    const csp = res!.headers()["content-security-policy"] ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce, "CSP header has a nonce").toBeTruthy();
    const scripts = await page.$$eval("script", (els) => els.map((e) => ({ nonce: (e as HTMLScriptElement).nonce, src: (e as HTMLScriptElement).src })));
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s.nonce, `script ${s.src || "(inline)"} nonce`).toBe(nonce);
    // A fresh request gets a fresh nonce.
    const again = /'nonce-([^']+)'/.exec((await page.request.get(path)).headers()["content-security-policy"] ?? "")?.[1];
    expect(again).not.toBe(nonce);
    await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
  });
}
