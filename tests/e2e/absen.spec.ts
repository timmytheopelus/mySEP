import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { SignJWT } from "jose";
import { ACC, KEP_A, KEP_B, KEP_C, MOCK_PORT, NAMES_A, SESSION_SECRET, SUB_A_TODAY, sessionClaims } from "./e2e-data";

type Who = keyof typeof ACC;
const N = NAMES_A.length;

async function login(context: BrowserContext, who: Who) {
  const a = ACC[who];
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sa: now, amr: ["pwd", "otp"], ...sessionClaims(a) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("kep")
    .setAudience("kep-session")
    .setSubject(a.id)
    .setJti(`e2e-${who}-${now}`)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SESSION_SECRET));
  await context.addCookies([{ name: "__Host-kep_session", value: token, url: "http://localhost:3000", secure: true, httpOnly: true }]);
}

test.beforeEach(async ({ request, context }) => {
  expect((await request.post(`http://127.0.0.1:${MOCK_PORT}/__reset`)).ok()).toBe(true);
  await login(context, "picA");
});

const rows = (page: Page) => page.getByTestId("peserta-row");
const rowBtn = (page: Page, nama: string) => page.getByRole("button", { name: new RegExp(`^${nama}`) });
const status = (page: Page) => page.getByTestId("sync-status");
const open = async (page: Page, kep = KEP_A) => {
  await page.goto(`/kep/${kep}/absen`);
  await expect(rows(page).first()).toBeVisible();
};

test.describe("halaman absen (390x844)", () => {
  test("membuka pertemuan hari ini otomatis, tanpa tombol Simpan, baris cukup besar", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("pertemuan-judul")).toContainText("Pertemuan 2 - Sabda");
    await expect(page.getByTestId("pertemuan-judul")).toContainText("Hari ini");
    await expect(page.getByTestId("hadir-count")).toHaveText(`0 dari ${N} hadir`);
    await expect(rows(page)).toHaveCount(N);
    for (const r of await rows(page).all()) expect((await r.boundingBox())!.height).toBeGreaterThanOrEqual(56);
    await expect(page.getByRole("button", { name: /simpan/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /kembali/i })).toHaveAttribute("href", `/kep/${KEP_A}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("ketuk langsung menampilkan centang sebelum respons server; ketuk lagi membatalkan; ada Batalkan", async ({ page }) => {
    let answered = false;
    await page.route("**/absen/*/set", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      answered = true;
      await route.continue();
    });
    await open(page);
    const btn = rowBtn(page, NAMES_A[0]);
    await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", "true", { timeout: 100 });
    expect(answered).toBe(false);
    await expect(page.getByTestId("hadir-count")).toHaveText(`1 dari ${N} hadir`);
    await expect(page.getByRole("status").getByRole("button", { name: "Batalkan" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveAttribute("aria-live", "polite");
    await expect(status(page)).toContainText("tersimpan", { timeout: 10_000 });
    await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", "false", { timeout: 100 });
    await expect(page.getByTestId("hadir-count")).toHaveText(`0 dari ${N} hadir`);
    await expect(status(page)).toContainText("tersimpan", { timeout: 10_000 });
    const sheet = await (await page.request.get(`/api/kep/${KEP_A}/absen/${SUB_A_TODAY}`)).json();
    expect(sheet.hadirCount).toBe(0);
  });

  test("Batalkan mengembalikan perubahan terakhir", async ({ page }) => {
    await open(page);
    const btn = rowBtn(page, NAMES_A[1]);
    await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Batalkan" }).click();
    await expect(btn).toHaveAttribute("aria-pressed", "false");
    await expect(status(page)).toContainText("tersimpan", { timeout: 10_000 });
    const sheet = await (await page.request.get(`/api/kep/${KEP_A}/absen/${SUB_A_TODAY}`)).json();
    expect(sheet.hadirCount).toBe(0);
  });

  test("offline menampung tiga ketukan lalu mengirim sekali per opId saat online", async ({ page, context }) => {
    await open(page);
    const ok: string[] = [];
    page.on("response", async (res) => {
      if (res.request().method() === "POST" && res.url().endsWith(`/absen/${SUB_A_TODAY}/set`) && res.ok()) ok.push(res.request().postDataJSON().opId);
    });
    await context.setOffline(true);
    for (const n of NAMES_A.slice(0, 3)) await rowBtn(page, n).click();
    await expect(page.getByTestId("hadir-count")).toHaveText(`3 dari ${N} hadir`);
    await expect(status(page)).toContainText("menunggu sinyal");
    expect(ok).toEqual([]);
    await context.setOffline(false);
    await expect(status(page)).toContainText("tersimpan", { timeout: 20_000 });
    expect(ok).toHaveLength(3);
    expect(new Set(ok).size).toBe(3);
    const sheet = await (await page.request.get(`/api/kep/${KEP_A}/absen/${SUB_A_TODAY}`)).json();
    expect(sheet.hadirCount).toBe(3);
  });

  test("antrean yang belum terkirim bertahan setelah muat ulang", async ({ page, context }) => {
    await open(page);
    await context.setOffline(true);
    await rowBtn(page, NAMES_A[2]).click();
    await expect(status(page)).toContainText("menunggu sinyal");
    await context.setOffline(false);
    await page.reload();
    await expect(rowBtn(page, NAMES_A[2])).toHaveAttribute("aria-pressed", "true");
    await expect(status(page)).toContainText("tersimpan", { timeout: 20_000 });
    const sheet = await (await page.request.get(`/api/kep/${KEP_A}/absen/${SUB_A_TODAY}`)).json();
    expect(sheet.hadirCount).toBe(1);
  });

  test("operasi yang ditolak permanen (409) dibatalkan di layar dan dihitung gagal", async ({ page }) => {
    await page.route("**/absen/*/set", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Peserta sudah mengundurkan diri" }) }));
    await open(page);
    const btn = rowBtn(page, NAMES_A[0]);
    await btn.click();
    await expect(status(page)).toContainText("1 gagal", { timeout: 10_000 });
    await expect(btn).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("hadir-count")).toHaveText(`0 dari ${N} hadir`);
    await expect(page.getByRole("alert")).toContainText("Peserta sudah mengundurkan diri");
  });

  test("Tandai semua hadir meminta konfirmasi dan mengulang sampai remaining=0", async ({ page }) => {
    const opIds: string[] = [];
    let calls = 0;
    await page.route("**/absen/*/semua", async (route) => {
      opIds.push(route.request().postDataJSON().opId);
      if (++calls === 1) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ updated: 3, remaining: 5 }) });
      return route.continue();
    });
    await open(page);
    await page.getByRole("button", { name: "Tandai semua hadir" }).click();
    const dlg = page.getByRole("alertdialog");
    await expect(dlg).toContainText("semua peserta");
    await dlg.getByRole("button", { name: "Batal" }).click();
    expect(calls).toBe(0);
    await page.getByRole("button", { name: "Tandai semua hadir" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Ya, tandai semua" }).click();
    await expect(page.getByTestId("hadir-count")).toHaveText(`${N} dari ${N} hadir`, { timeout: 15_000 });
    expect(calls).toBe(2);
    expect(new Set(opIds).size).toBe(1);
  });

  test("menu ⋯ → Mengundurkan diri meredupkan baris; bisa dibatalkan", async ({ page }) => {
    await open(page);
    const nama = NAMES_A[3];
    const row = rows(page).filter({ hasText: nama });
    await page.getByRole("button", { name: `Menu untuk ${nama}` }).click();
    await page.getByRole("menuitem", { name: "Mengundurkan diri" }).click();
    await expect(row).toHaveAttribute("data-mundur", "true");
    expect(await row.evaluate((e) => Number(getComputedStyle(e).opacity))).toBeLessThan(1);
    await expect(page.getByTestId("hadir-count")).toHaveText(`0 dari ${N - 1} hadir`);
    await expect(status(page)).toContainText("tersimpan", { timeout: 10_000 });
    await page.getByRole("button", { name: `Menu untuk ${nama}` }).click();
    await page.getByRole("menuitem", { name: "Batalkan pengunduran diri" }).click();
    await expect(row).not.toHaveAttribute("data-mundur", "true");
    await expect(page.getByTestId("hadir-count")).toHaveText(`0 dari ${N} hadir`);
    await expect(status(page)).toContainText("tersimpan", { timeout: 10_000 });
  });

  test("pencarian memfilter daftar", async ({ page }) => {
    await open(page);
    await page.getByRole("searchbox", { name: /cari/i }).fill("agnes");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(NAMES_A[0]);
    await page.getByRole("searchbox", { name: /cari/i }).fill("zzz");
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByText("Tidak ada peserta")).toBeVisible();
    await page.getByRole("searchbox", { name: /cari/i }).fill("");
    await expect(rows(page)).toHaveCount(N);
  });
});

test.describe("akses", () => {
  test("belum masuk → /login; SEP → beranda; paroki lain → 404", async ({ browser, page, context }) => {
    const anon = await browser.newContext();
    const p0 = await anon.newPage();
    await p0.goto(`/kep/${KEP_A}/absen`);
    await expect(p0).toHaveURL(/\/login/);
    await anon.close();

    await context.clearCookies();
    await login(context, "sep");
    await page.goto(`/kep/${KEP_A}/absen`);
    await expect(page).not.toHaveURL(/\/absen/);

    await context.clearCookies();
    await login(context, "picB");
    const res = await page.goto(`/kep/${KEP_A}/absen`);
    expect(res!.status()).toBe(404);
    expect((await page.goto(`/kep/${KEP_A}/penetapan`))!.status()).toBe(404);
  });
});

test.describe("laptop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("panah memindah fokus, Spasi menandai, fokus terlihat", async ({ page }) => {
    await open(page);
    await rowBtn(page, NAMES_A[0]).focus();
    await page.keyboard.press("ArrowDown");
    await expect(rowBtn(page, NAMES_A[1])).toBeFocused();
    await page.keyboard.press("Space");
    await expect(rowBtn(page, NAMES_A[1])).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowUp");
    await expect(rowBtn(page, NAMES_A[0])).toBeFocused();
    const ring = await rowBtn(page, NAMES_A[0]).evaluate((e) => {
      const s = getComputedStyle(e);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);
    await expect(status(page)).toContainText("tersimpan", { timeout: 10_000 });
  });
});

test.describe("penetapan", () => {
  test("dinonaktifkan sebelum pertemuan terakhir dengan alasan", async ({ page }) => {
    await page.goto(`/kep/${KEP_A}/penetapan`);
    await expect(page.getByTestId("penetapan-alasan")).toContainText("pertemuan terakhir");
    await expect(page.getByRole("button", { name: /^Lulus/ }).first()).toBeDisabled();
    await expect(page.getByRole("link", { name: /kembali/i })).toHaveAttribute("href", `/kep/${KEP_A}`);
  });

  test("PIC menetapkan LULUS / TIDAK LULUS pada hari pertemuan terakhir", async ({ page }) => {
    await page.goto(`/kep/${KEP_B}/penetapan`);
    const first = page.getByTestId("penetapan-row").first();
    const lulus = first.getByRole("button", { name: /^Lulus/ });
    await expect(lulus).toBeEnabled();
    await lulus.click();
    await expect(lulus).toHaveAttribute("aria-pressed", "true");
    await expect(first.getByTestId("penetapan-status")).toContainText("tersimpan");
    await page.reload();
    await expect(page.getByTestId("penetapan-row").first().getByRole("button", { name: /^Lulus/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("penetapan-row").first().getByRole("button", { name: /^Tidak lulus/ }).click();
    await expect(page.getByTestId("penetapan-row").first().getByRole("button", { name: /^Tidak lulus/ })).toHaveAttribute("aria-pressed", "true");
  });

  test("paroki lain: 404", async ({ page, context }) => {
    await context.clearCookies();
    await login(context, "picB");
    expect((await page.goto(`/kep/${KEP_B}/penetapan`))!.status()).toBe(404);
    expect(KEP_C).toBeTruthy();
  });
});

test.describe("PWA", () => {
  test("manifest valid, service worker terdaftar di bawah CSP, tidak menyimpan API atau HTML", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    const m = await page.request.get("/manifest.webmanifest");
    expect(m.ok()).toBe(true);
    const manifest = await m.json();
    expect(manifest).toMatchObject({ display: "standalone", lang: "id" });
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const i of manifest.icons) expect((await page.request.get(i.src)).ok()).toBe(true);
    await open(page);
    await page.evaluate(async () => void (await navigator.serviceWorker.ready));
    await rowBtn(page, NAMES_A[0]).click();
    await expect(status(page)).toContainText("tersimpan", { timeout: 10_000 });
    await page.reload();
    await expect(rows(page).first()).toBeVisible();
    const cached = await page.evaluate(async () => {
      const out: string[] = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
      return out;
    });
    expect(cached.filter((p) => p.startsWith("/api/") || p.startsWith("/kep") || p === "/")).toEqual([]);
    expect(errors.filter((e) => !e.includes("favicon"))).toEqual([]);
  });
});
