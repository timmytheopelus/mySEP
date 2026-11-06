import { expect, test, type Page } from "@playwright/test";
import { HEALTH_TEXT, KEP_A, KEP_C, KEP_D, MOCK_PORT, NAMES_A, SUB_A_TODAY } from "./e2e-data";
import { login, type Who } from "./auth";

test.beforeEach(async ({ request }) => {
  expect((await request.post(`http://127.0.0.1:${MOCK_PORT}/__reset`)).ok()).toBe(true);
});
const as = async (page: Page, who: Who) => login(page.context(), who);
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe("jadwal: tanggal dan jam (I7)", () => {
  test("PIC menyesuaikan tanggal dan jam pertemuan setelah KEP disetujui; tersimpan, tetap setelah muat ulang; pewarta tetap terkunci", async ({ page }) => {
    await as(page, "picA");
    await page.goto(`/kep/${KEP_A}/jadwal`);
    const item = page.getByTestId("jadwal-item").nth(2); // +7 hari
    await expect(item.getByRole("button", { name: /ubah pewarta/i })).toHaveCount(0);
    const waktu = item.getByTestId("jadwal-waktu");
    const date = waktu.getByLabel("Tanggal");
    const target = (await date.inputValue()).replace(/-\d\d$/, "-28");
    await date.fill(target);
    await waktu.getByLabel("Jam mulai").fill("18:30");
    await waktu.getByLabel("Jam selesai").fill("17:00");
    await waktu.getByRole("button", { name: /simpan jadwal/i }).click();
    await expect(item.getByTestId("jadwal-waktu-msg")).toContainText(/setelah jam mulai/i); // validated before any request
    await waktu.getByLabel("Jam selesai").fill("20:30");
    // "Tersimpan." is shown optimistically; wait for the server's answer before reloading
    const answered = page.waitForResponse((r) => r.url().includes("/jadwal") && r.request().method() === "POST");
    await waktu.getByRole("button", { name: /simpan jadwal/i }).click();
    expect((await answered).status()).toBe(200);
    await expect(item.getByTestId("jadwal-waktu-msg")).toHaveText("Tersimpan.");
    await expect(item.getByTestId("jadwal-when")).toContainText("18:30 - 20:30");
    await page.reload();
    const again = page.getByTestId("jadwal-item").nth(2).getByTestId("jadwal-waktu");
    await expect(again.getByLabel("Tanggal")).toHaveValue(target);
    await expect(again.getByLabel("Jam mulai")).toHaveValue("18:30");
    expect(await noHScroll(page)).toBe(true);
  });
  test("tanggal di luar rentang ditolak server (422); Admin Paroki 403; PIC paroki lain 404", async ({ page }) => {
    await as(page, "picA");
    const post = (data: unknown, id = KEP_A) =>
      page.request.post(`/api/kep/${id}/subevent/${SUB_A_TODAY}/jadwal`, { headers: { "Sec-Fetch-Site": "same-origin" }, data });
    expect((await post({ tanggal: "2001-01-01", jamMulai: "", jamSelesai: "", opId: "op-e2e-waktu-0001" })).status()).toBe(422);
    await page.context().clearCookies();
    await as(page, "admA");
    expect((await post({ tanggal: "2030-01-01", jamMulai: "", jamSelesai: "", opId: "op-e2e-waktu-0002" })).status()).toBe(403);
    await page.context().clearCookies();
    await as(page, "picB");
    expect((await post({ tanggal: "2030-01-01", jamMulai: "", jamSelesai: "", opId: "op-e2e-waktu-0003" })).status()).toBe(404);
  });
  test("SEP mengubah jadwal KEP yang diajukan; halaman menampilkan kolom tanggal", async ({ page }) => {
    await as(page, "sep");
    await page.goto(`/kep/${KEP_D}/jadwal`);
    await expect(page.getByTestId("jadwal-waktu")).toHaveCount(2);
  });
});

test.describe("absen: peserta datang langsung (I8)", () => {
  test("Admin menambah peserta (nama + WA): langsung hadir, hitungan naik, hub menandai data belum lengkap", async ({ page }) => {
    await as(page, "admA");
    await page.goto(`/kep/${KEP_A}/absen?p=${SUB_A_TODAY}`);
    await expect(page.getByTestId("hadir-count")).toContainText("0 dari 8");
    await page.getByRole("button", { name: /tambah peserta/i }).click();
    const dlg = page.getByRole("alertdialog");
    await expect(dlg.getByLabel("Nama lengkap")).toBeFocused();
    await dlg.getByLabel("Nama lengkap").fill("Tamu Datang Langsung");
    await dlg.getByLabel("Nomor WhatsApp").fill("0813-5555-0101");
    await dlg.getByRole("button", { name: /tambah dan tandai hadir/i }).click();
    await expect(dlg).toHaveCount(0);
    const row = page.getByRole("listitem").filter({ hasText: "Tamu Datang Langsung" });
    await expect(row).toHaveCount(1);
    await expect(page.getByText(/1 dari 9 hadir/)).toBeVisible();
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "ok");
    // the hub (PIC) shows the badge and the count; names only
    await page.context().clearCookies();
    await as(page, "picA");
    await page.goto(`/kep/${KEP_A}`);
    await expect(page.getByTestId("peserta-item").filter({ hasText: "Tamu Datang Langsung" }).getByTestId("data-belum-lengkap")).toBeVisible();
    await expect(page.getByTestId("belum-lengkap-jumlah")).toContainText(/\d+ peserta masih perlu dilengkapi/);
    expect((await page.locator("body").innerText()).replace(/\s/g, "")).not.toContain("08135550101");
  });
  test("validasi: WhatsApp salah menampilkan pesan di dialog dan tidak menambah peserta; Batal menutup", async ({ page }) => {
    await as(page, "admA");
    await page.goto(`/kep/${KEP_A}/absen?p=${SUB_A_TODAY}`);
    await page.getByRole("button", { name: /tambah peserta/i }).click();
    const dlg = page.getByRole("alertdialog");
    await dlg.getByLabel("Nama lengkap").fill("Tamu Salah");
    await dlg.getByLabel("Nomor WhatsApp").fill("12");
    await dlg.getByRole("button", { name: /tambah dan tandai hadir/i }).click();
    await expect(dlg.getByTestId("walkin-error")).toContainText(/whatsapp/i);
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByText("Tamu Salah")).toHaveCount(0);
  });
  test("tanpa sinyal: pesan jelas, tidak diantre", async ({ page, context }) => {
    await as(page, "admA");
    await page.goto(`/kep/${KEP_A}/absen?p=${SUB_A_TODAY}`);
    await page.getByRole("button", { name: /tambah peserta/i }).click();
    const dlg = page.getByRole("alertdialog");
    await dlg.getByLabel("Nama lengkap").fill("Tamu Offline");
    await dlg.getByLabel("Nomor WhatsApp").fill("0813-5555-0202");
    await context.setOffline(true);
    await dlg.getByRole("button", { name: /tambah dan tandai hadir/i }).click();
    await expect(dlg.getByTestId("walkin-error")).toContainText(/tidak ada sinyal/i);
    await context.setOffline(false);
  });
});

test.describe("layar data kesehatan (/kep/[id]/kesehatan)", () => {
  test("PIC dan Admin paroki sendiri melihat catatan; no-store; tautan dari hub; tidak ada geser horizontal", async ({ page }) => {
    for (const who of ["picA", "admA"] as const) {
      await page.context().clearCookies();
      await as(page, who);
      await page.goto(`/kep/${KEP_A}`);
      await page.getByRole("link", { name: /data kesehatan peserta/i }).click();
      await expect(page).toHaveURL(new RegExp(`/kep/${KEP_A}/kesehatan$`));
      const items = page.getByTestId("kesehatan-item");
      await expect(items).toHaveCount(2);
      await expect(items.filter({ hasText: NAMES_A[0] })).toContainText(HEALTH_TEXT.penyakit);
      await expect(items.filter({ hasText: NAMES_A[0] })).toContainText(HEALTH_TEXT.kontak);
      await expect(items.filter({ hasText: NAMES_A[1] })).toContainText(HEALTH_TEXT.alergi);
      expect(await noHScroll(page)).toBe(true);
    }
    const res = await page.request.get(`/kep/${KEP_A}/kesehatan`);
    expect(res.headers()["cache-control"]).toContain("no-store");
  });
  test("SEP dialihkan, tanpa tautan di hub dan tanpa data; paroki lain 404; tanpa sesi ke login", async ({ page }) => {
    await as(page, "sep");
    await page.goto(`/kep/${KEP_A}`);
    await expect(page.getByRole("link", { name: /data kesehatan/i })).toHaveCount(0);
    await page.goto(`/kep/${KEP_A}/kesehatan`);
    await expect(page).toHaveURL(new RegExp(`/kep/${KEP_A}$`));
    expect(await page.locator("body").innerText()).not.toContain(HEALTH_TEXT.penyakit);
    await page.context().clearCookies();
    await as(page, "picB");
    expect((await page.goto(`/kep/${KEP_A}/kesehatan`))?.status()).toBe(404);
    expect((await page.goto(`/kep/${KEP_C}/kesehatan`))?.status()).toBe(200);
    await page.context().clearCookies();
    await page.goto(`/kep/${KEP_A}/kesehatan`);
    await expect(page).toHaveURL(/\/login/);
  });
  test("cetak: tanpa navigasi dan tombol, A4", async ({ page }) => {
    await as(page, "picA");
    await page.goto(`/kep/${KEP_A}/kesehatan`);
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("navigation")).toBeHidden();
    await expect(page.getByRole("button", { name: /cetak/i })).toBeHidden();
    await expect(page.getByTestId("kesehatan-item").first()).toBeVisible();
  });
});
