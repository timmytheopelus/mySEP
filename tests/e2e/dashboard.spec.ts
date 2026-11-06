import { expect, test, type Page } from "@playwright/test";
import { KEP_A, KEP_C, MOCK_PORT } from "./e2e-data";
import { login, type Who } from "./auth";

test.beforeEach(async ({ request }) => {
  expect((await request.post(`http://127.0.0.1:${MOCK_PORT}/__reset`)).ok()).toBe(true);
});
const as = (page: Page, who: Who) => login(page.context(), who);
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe("dashboard", () => {
  test("PIC: hanya paroki sendiri, kartu di HP, tanpa gulir mendatar, tautan menu dan manifest", async ({ page }) => {
    await as(page, "picA");
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard paroki" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Rekap per angkatan" })).toBeVisible();
    await expect(page.locator("table").first()).toBeHidden();
    await expect(page.getByText(/St\. E2E B|Belum terpetakan/)).toHaveCount(0);
    expect(await noHScroll(page)).toBe(true);
    await expect(page.getByRole("navigation", { name: "Menu utama" }).getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  });
  test("PIC di laptop melihat tabel; dasbor SEP dialihkan", async ({ page }) => {
    await as(page, "picA");
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto("/dashboard");
    await expect(page.getByRole("table", { name: "Rekap per angkatan" })).toBeVisible();
    await page.goto("/dashboard/sep");
    await expect(page).toHaveURL(/\/dashboard$/);
  });
  test("SEP: semua paroki, antrean, profil; dialihkan dari /dashboard", async ({ page }) => {
    await as(page, "sep");
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard\/sep$/);
    await expect(page.getByRole("heading", { name: "Sebaran paroki" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Buka antrean" })).toHaveAttribute("href", "/kep/antrean");
    await expect(page.getByText("St. E2E A").first()).toBeVisible();
    await expect(page.getByText("St. E2E B").first()).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
  });
  test("API laporan: CSV unduhan, lintas paroki 404, tanpa sesi 401", async ({ page, request }) => {
    expect((await request.get("/api/laporan/tren")).status()).toBe(401);
    await as(page, "picA");
    const csv = await page.request.get("/api/laporan/rekap-angkatan?format=csv");
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-disposition"]).toContain("attachment");
    expect(await csv.text()).not.toContain("St. E2E B");
    expect((await page.request.get(`/api/laporan/kehadiran?kep=${KEP_C}`)).status()).toBe(404);
    expect((await page.request.get(`/api/laporan/kehadiran?kep=${KEP_A}`)).status()).toBe(200);
  });
});
