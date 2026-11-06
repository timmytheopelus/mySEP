import { expect, test } from "@playwright/test";

const noHorizontalScroll = () => document.documentElement.scrollWidth <= window.innerWidth;

test.describe("landing page", () => {
  for (const vp of [
    { name: "mobile 390x844", width: 390, height: 844 },
    { name: "laptop 1280x800", width: 1280, height: 800 },
  ]) {
    test(`renders content, stats and login link at ${vp.name}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && !m.location().url.includes("favicon") && errors.push(m.text()));
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Apa itu KEP?" })).toBeVisible();
      for (const label of ["Paroki", "Angkatan", "Lulusan"]) {
        await expect(page.getByTestId(`stat-${label.toLowerCase()}`)).toContainText(/\d+/);
      }
      await expect(page.getByRole("heading", { name: "Paroki penyelenggara" })).toBeVisible();
      await expect(page.getByTestId("daftar-paroki").getByRole("listitem").first()).toBeVisible();
      const masuk = page.getByRole("link", { name: "Masuk" }).first();
      await expect(masuk).toHaveAttribute("href", "/login");
      expect(await page.evaluate(noHorizontalScroll)).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  test("has no inline style attributes", async ({ page }) => {
    await page.goto("/");
    // <next-route-announcer> sets its own style through the CSSOM at runtime (allowed by CSP); it is not in the served HTML.
    const html = await (await page.request.get("/")).text();
    expect(html).not.toMatch(/<[a-z][^>]*\sstyle=/i);
    const offenders = await page.evaluate(() =>
      [...document.querySelectorAll("[style]")].filter((e) => !e.closest("next-route-announcer")).map((e) => e.outerHTML.slice(0, 120)),
    );
    expect(offenders).toEqual([]);
  });
});
