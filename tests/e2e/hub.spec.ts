import { expect, test, type Page } from "@playwright/test";
import { ACC, KEP_A, KEP_B, KEP_C, KEP_D, MOCK_PORT, NAMES_A, PENGAJAR_1, SUB_A_TODAY } from "./e2e-data";
import { login, type Who } from "./auth";

test.beforeEach(async ({ request }) => {
  expect((await request.post(`http://127.0.0.1:${MOCK_PORT}/__reset`)).ok()).toBe(true);
});

const as = async (page: Page, who: Who) => login(page.context(), who);
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe("daftar KEP (/kep)", () => {
  test("PIC melihat KEP paroki sendiri saja; ada tautan ke pengajuan baru", async ({ page }) => {
    await as(page, "picA");
    await page.goto("/kep");
    const items = page.getByTestId("kep-item");
    await expect(items).toHaveCount(3);
    await expect(items.filter({ hasText: "KEP E2E A" })).toHaveAttribute("href", `/kep/${KEP_A}`);
    await expect(page.getByText("KEP E2E C")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /ajukan kep baru/i })).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
  });
  test("SEP melihat semua KEP, tanpa tombol ajukan", async ({ page }) => {
    await as(page, "sep");
    await page.goto("/kep");
    await expect(page.getByTestId("kep-item").filter({ hasText: "KEP E2E C" })).toBeVisible();
    await expect(page.getByTestId("kep-item").filter({ hasText: "KEP E2E A" })).toBeVisible();
    await expect(page.getByRole("link", { name: /ajukan kep baru/i })).toHaveCount(0);
  });
  test("akun tanpa paroki melihat pesan jelas, bukan galat", async ({ page }) => {
    await as(page, "picX");
    await page.goto("/kep");
    await expect(page.getByText(/belum terhubung ke paroki/i)).toBeVisible();
  });
  test("tanpa sesi diarahkan ke login", async ({ page }) => {
    await page.goto("/kep");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("hub detail KEP (390x844)", () => {
  test("PIC: nama, status, statistik, jadwal 3 pertemuan, daftar peserta, tautan kerja", async ({ page }) => {
    await as(page, "picA");
    await page.goto(`/kep/${KEP_A}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("KEP E2E A");
    await expect(page.getByTestId("kep-status")).toHaveText("Disetujui");
    await expect(page.getByTestId("stat-aktif")).toHaveText("8");
    await expect(page.getByTestId("stat-mundur")).toHaveText("0");
    await expect(page.getByTestId("stat-lulus")).toHaveText("0");
    const rows = page.getByTestId("pertemuan-item");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText("Hari ini");
    await expect(rows.nth(1)).toContainText("0 dari 8 hadir");
    const peserta = page.getByTestId("peserta-item");
    await expect(peserta).toHaveCount(8);
    for (const n of NAMES_A) await expect(peserta.filter({ hasText: n })).toHaveCount(1);
    await expect(page.getByRole("link", { name: /absen hari ini/i })).toHaveAttribute("href", `/kep/${KEP_A}/absen?p=${SUB_A_TODAY}`);
    await expect(page.getByRole("link", { name: /penetapan/i })).toHaveAttribute("href", `/kep/${KEP_A}/penetapan`);
    await expect(page.getByRole("link", { name: /impor/i })).toHaveAttribute("href", `/kep/${KEP_A}/import`);
    await expect(page.getByRole("link", { name: /jadwal/i }).first()).toHaveAttribute("href", `/kep/${KEP_A}/jadwal`);
    expect(await noHScroll(page)).toBe(true);
  });

  test("absen hari ini membuka pertemuan hari ini", async ({ page }) => {
    await as(page, "picA");
    await page.goto(`/kep/${KEP_A}`);
    await page.getByRole("link", { name: /absen hari ini/i }).click();
    await expect(page.getByTestId("pertemuan-judul")).toContainText("Pertemuan 2 - Sabda");
  });

  test("tidak pernah menampilkan data kesehatan, kontak darurat atau nomor telepon", async ({ page }) => {
    await as(page, "picA");
    await page.goto(`/kep/${KEP_A}`);
    const text = (await page.locator("body").innerText()).toLowerCase();
    for (const bad of ["riwayat penyakit", "alergi", "obat rutin", "kontak darurat", "no. hp", "nomor hp"]) expect(text).not.toContain(bad);
  });

  test("lintas paroki: 404; id ngawur: 404", async ({ page }) => {
    await as(page, "picB");
    expect((await page.goto(`/kep/${KEP_A}`))?.status()).toBe(404);
    expect((await page.goto(`/kep/tidak-ada`))?.status()).toBe(404);
  });

  test("SEP: hanya agregat, tanpa daftar nama, tanpa form, tanpa tautan pendaftaran", async ({ page }) => {
    await as(page, "sep");
    await page.goto(`/kep/${KEP_A}`);
    await expect(page.getByTestId("stat-aktif")).toHaveText("8");
    await expect(page.getByTestId("pertemuan-item")).toHaveCount(3);
    await expect(page.getByTestId("peserta-item")).toHaveCount(0);
    await expect(page.getByText(NAMES_A[0])).toHaveCount(0);
    await expect(page.getByRole("button", { name: /tambah peserta/i })).toHaveCount(0);
    await expect(page.getByTestId("tautan-daftar")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /absen hari ini/i })).toHaveCount(0);
  });
});

test.describe("Admin Paroki (tanpa kelola pewarta/tautan/form)", () => {
  test("melihat hub, tetapi tanpa tautan pendaftaran, form peserta, impor, atau jadwal", async ({ page }) => {
    await as(page, "admA");
    await page.goto(`/kep/${KEP_A}`);
    await expect(page.getByTestId("peserta-item")).toHaveCount(8);
    await expect(page.getByTestId("tautan-daftar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /tambah peserta/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /impor/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /jadwal/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /absen hari ini/i })).toBeVisible();
    expect((await page.request.get(`/api/kep/${KEP_A}/link-daftar`)).status()).toBe(403);
    await page.goto(`/kep/${KEP_D}/jadwal`);
    await expect(page).not.toHaveURL(/\/jadwal$/);
  });
});

test.describe("tautan pendaftaran", () => {
  test("tampil dengan QR, bisa disalin, dan 'buat tautan baru' mencabut yang lama", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:3000" }).catch(() => undefined);
    await as(page, "picA");
    await page.goto(`/kep/${KEP_A}`);
    const box = page.getByTestId("tautan-daftar");
    const input = box.getByRole("textbox", { name: /tautan pendaftaran/i });
    const before = await input.inputValue();
    expect(before).toMatch(/^http:\/\/localhost:3000\/daftar\/.+\..+$/);
    await expect(box.getByRole("img", { name: /kode qr/i })).toBeVisible();
    await expect(box).toContainText(/berlaku sampai/i);
    await box.getByRole("button", { name: /salin tautan/i }).click();
    await expect(box.getByRole("status")).toContainText(/disalin/i);

    // the old link works for the public...
    const pub = await context.newPage();
    await pub.goto(before);
    await expect(pub.getByRole("heading", { name: "Pendaftaran peserta" })).toBeVisible();

    // ...until the PIC rotates it
    await box.getByRole("button", { name: /buat tautan baru/i }).click();
    await expect(box).toContainText(/berhenti berfungsi/i);
    await box.getByRole("button", { name: /ya, cabut tautan lama/i }).click();
    await expect(input).not.toHaveValue(before);
    const after = await input.inputValue();
    await pub.goto(before);
    await expect(pub.getByRole("heading", { name: /pendaftaran tidak tersedia/i })).toBeVisible();
    await pub.goto(after);
    await expect(pub.getByRole("heading", { name: "Pendaftaran peserta" })).toBeVisible();
  });
});

test.describe("tambah peserta manual", () => {
  async function fill(page: Page, nama: string) {
    const f = page.getByTestId("tambah-peserta");
    await f.getByLabel(/nama lengkap/i).fill(nama);
    await f.getByLabel("Jenis kelamin").selectOption("Pria");
    await f.getByLabel("Tanggal lahir").fill("1985-04-12");
    await f.getByLabel("Nomor WhatsApp").fill("0812 3456 7001");
    await f.getByLabel("Email", { exact: false }).first().fill("baru.peserta@example.com");
    await f.getByLabel("Alamat tinggal").fill("Jl. Merdeka 1, Bandung");
    await f.getByLabel("Paroki asal").selectOption({ label: "St. E2E A" });
    await f.getByLabel("Status pernikahan").selectOption("Single");
    await f.getByLabel("Nama dan nomor telepon").fill("Ibu 081111111111");
    await f.getByLabel("Nama pendukung doa 1").fill("Ana");
    await f.getByLabel("Kontak pendukung doa 1").fill("081200000001");
    await f.getByLabel("Nama pendukung doa 2").fill("Budi");
    await f.getByLabel("Kontak pendukung doa 2").fill("081200000002");
    return f;
  }

  test("menyatakan batasan data lama, mendaftarkan peserta baru tanpa data kesehatan", async ({ page }) => {
    await as(page, "picA");
    await page.goto(`/kep/${KEP_A}`);
    await page.getByRole("button", { name: /tambah peserta/i }).click();
    const f = await fill(page, "Yustinus Baru");
    await expect(f).toContainText(/email yang tercatat/i);
    await expect(f).toContainText(/ubah profil/i);
    await expect(f.getByLabel(/peserta telah menyetujui/i)).toHaveCount(0);
    await f.getByRole("button", { name: /^daftarkan/i }).click();
    await expect(f.getByRole("status")).toContainText(/peserta didaftarkan/i);
    await page.reload();
    await expect(page.getByTestId("peserta-item").filter({ hasText: "Yustinus Baru" })).toHaveCount(1);
    await expect(page.getByTestId("stat-aktif")).toHaveText("9");
  });

  test("data kesehatan mewajibkan persetujuan peserta yang dicatat PIC", async ({ page }) => {
    await as(page, "picA");
    await page.goto(`/kep/${KEP_A}`);
    await page.getByRole("button", { name: /tambah peserta/i }).click();
    const f = await fill(page, "Maria Sehat");
    await f.locator("summary").click();
    await f.getByLabel("Riwayat alergi").fill("Udang");
    const consent = f.getByLabel(/peserta telah menyetujui/i);
    await expect(consent).toBeVisible();
    await expect(consent).toHaveAttribute("required", "");
    await f.getByRole("button", { name: /^daftarkan/i }).click();
    await expect(page.getByTestId("peserta-item").filter({ hasText: "Maria Sehat" })).toHaveCount(0);
    await consent.check();
    await f.getByRole("button", { name: /^daftarkan/i }).click();
    await expect(f.getByRole("status")).toContainText(/peserta didaftarkan/i);
    await page.reload();
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).not.toContain("udang");
  });
});

test.describe("jadwal dan pewarta", () => {
  test("PIC menugaskan pewarta per pertemuan; tersimpan setelah muat ulang; yang tidak aktif tidak ditawarkan", async ({ page }) => {
    await as(page, "picA");
    await page.goto(`/kep/${KEP_D}/jadwal`);
    const rows = page.getByTestId("jadwal-item");
    await expect(rows).toHaveCount(2);
    const first = rows.first();
    await expect(first).toContainText("belum ditugaskan");
    await first.getByRole("button", { name: /ubah pewarta/i }).click();
    await expect(first.getByRole("checkbox", { name: "Pewarta Pensiun" })).toHaveCount(0);
    await first.getByRole("checkbox", { name: "Pewarta Satu" }).check();
    await first.getByRole("button", { name: /^simpan/i }).click();
    await expect(first.getByRole("status")).toContainText(/tersimpan/i);
    await page.reload();
    await expect(page.getByTestId("jadwal-item").first()).toContainText("Pewarta: Pewarta Satu");
    await expect(page.getByTestId("jadwal-item").nth(1)).toContainText("belum ditugaskan");
    await page.getByTestId("jadwal-item").first().getByRole("button", { name: /ubah pewarta/i }).click();
    await expect(page.getByTestId("jadwal-item").first().getByRole("checkbox", { name: "Pewarta Satu" })).toBeChecked();
    // the hub shows that pertemuan 1 now has a pewarta
    await page.goto(`/kep/${KEP_D}`);
    await expect(page.getByTestId("pertemuan-item").first()).toContainText(/pewarta/i);
    // no phone numbers anywhere
    expect((await page.locator("body").innerText()).toLowerCase()).not.toMatch(/\b08\d{8,}/);
    void PENGAJAR_1;
  });
  test("setelah disetujui jadwal pewarta terkunci: hanya-baca dengan penjelasan, API menolak", async ({ page }) => {
    await as(page, "picA");
    await page.goto(`/kep/${KEP_A}/jadwal`);
    await expect(page.getByText(/terkunci setelah (kep )?disetujui/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /ubah pewarta/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^simpan/i })).toHaveCount(0);
    const r = await page.request.post(`/api/kep/${KEP_A}/subevent/${SUB_A_TODAY}/pengajar`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
      data: { pengajarIds: [PENGAJAR_1], opId: "op-e2e-lock-0001" },
    });
    expect(r.status()).toBe(409);
    await page.goto(`/kep/${KEP_A}`);
    await expect(page.getByText(/pewarta terkunci/i).first()).toBeVisible();
  });
  test("SEP dan PIC paroki lain tidak bisa membuka jadwal", async ({ page }) => {
    await as(page, "picB");
    expect((await page.goto(`/kep/${KEP_A}/jadwal`))?.status()).toBe(404);
    await page.context().clearCookies();
    await as(page, "sep");
    await page.goto(`/kep/${KEP_A}/jadwal`);
    await expect(page).not.toHaveURL(/\/jadwal$/);
  });
});

test.describe("navigasi", () => {
  test("PIC: KEP, Pewarta, Akun, Keluar; tanpa Antrean", async ({ page }) => {
    await as(page, "picA");
    await page.goto("/kep");
    const nav = page.getByRole("navigation", { name: "Menu utama" });
    await expect(nav.getByRole("link", { name: "KEP" })).toHaveAttribute("href", "/kep");
    await expect(nav.getByRole("link", { name: "Pewarta" })).toHaveAttribute("href", "/pewarta");
    await expect(nav.getByRole("link", { name: "Akun" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Keluar" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Antrean" })).toHaveCount(0);
    expect(await noHScroll(page)).toBe(true);
  });
  test("SEP melihat Antrean dan Akun ke /akun", async ({ page }) => {
    await as(page, "sep");
    await page.goto("/kep");
    const nav = page.getByRole("navigation", { name: "Menu utama" });
    await expect(nav.getByRole("link", { name: "Antrean" })).toHaveAttribute("href", "/kep/antrean");
    await expect(nav.getByRole("link", { name: "Akun" })).toHaveAttribute("href", "/akun");
  });
  test("Keluar menghapus antrean offline di perangkat SEBELUM memanggil API logout", async ({ page }) => {
    await as(page, "picA");
    await page.goto("/kep");
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open("keyval-store");
          open.onupgradeneeded = () => open.result.createObjectStore("keyval");
          open.onsuccess = () => {
            const tx = open.result.transaction("keyval", "readwrite");
            tx.objectStore("keyval").put([{ opId: "op-e2e-0001", url: "/x", body: {}, owner: "a" }], "kep:queue");
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    let queueAtLogout: number | null = null;
    await page.route("**/api/auth/logout", async (route) => {
      queueAtLogout = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const open = indexedDB.open("keyval-store");
            open.onsuccess = () => {
              const req = open.result.transaction("keyval").objectStore("keyval").get("kep:queue");
              req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result.length : 0);
            };
          }),
      );
      await route.continue();
    });
    await page.getByRole("navigation", { name: "Menu utama" }).getByRole("button", { name: "Keluar" }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(queueAtLogout).toBe(0);
  });
});

test.describe("keluar dengan absen belum terkirim", () => {
  const queue = (owner: string) =>
    new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("keyval-store");
      open.onupgradeneeded = () => open.result.createObjectStore("keyval");
      open.onsuccess = () => {
        const tx = open.result.transaction("keyval", "readwrite");
        tx.objectStore("keyval").put([{ opId: "op-e2e-0002", url: "/x", body: {}, owner }], "kep:queue");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
  test("meminta konfirmasi (bawaan: tetap di sini); antrean tidak hilang kalau batal", async ({ page }) => {
    await as(page, "picA");
    await page.goto("/kep");
    await page.evaluate(queue, ACC.picA.id);
    const nav = page.getByRole("navigation", { name: "Menu utama" });
    await nav.getByRole("button", { name: "Keluar" }).click();
    const dlg = page.getByRole("alertdialog");
    await expect(dlg).toContainText("1 absen belum terkirim akan hilang. Keluar sekarang?");
    await expect(dlg.getByRole("button", { name: /tetap di sini/i })).toBeFocused();
    await dlg.getByRole("button", { name: /tetap di sini/i }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page).toHaveURL(/\/kep$/);
    const left = await page.evaluate(() => new Promise<number>((res) => {
      const o = indexedDB.open("keyval-store");
      o.onsuccess = () => { const g = o.result.transaction("keyval").objectStore("keyval").get("kep:queue"); g.onsuccess = () => res(Array.isArray(g.result) ? g.result.length : 0); };
    }));
    expect(left).toBe(1);
    await nav.getByRole("button", { name: "Keluar" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: /keluar sekarang/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

void ACC;
void KEP_B;
void KEP_C;
