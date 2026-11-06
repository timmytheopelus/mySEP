# Runbook Operasional — Aplikasi KEP Keuskupan Bandung

Dokumen ini untuk pengelola aplikasi (bukan programmer pun bisa mengikuti). Ikuti langkahnya berurutan.
Istilah: **Vercel** = tempat aplikasi berjalan; **Airtable** = database (base **BPK Bandung**, `appIGR8Duhj3Vsz48`);
**Upstash** = penyimpanan kecil bersama untuk pembatas percobaan (rate limit) dan daftar sesi yang sudah keluar.

> Aturan tetap: aplikasi **tidak pernah menghapus** data atau tabel. Jangan pernah memberi token Airtable izin
> mengubah skema. Setiap tabel/field baru di Airtable wajib dilaporkan dan diemail ke timmy.theopelus@gmail.com.

---

## 1. Token Airtable berizin minimal

1. Masuk ke Airtable dengan akun pemilik base BPK Bandung → buka <https://airtable.com/create/tokens>.
2. Klik **Create new token**. Nama: `kep-app-produksi-YYYYMM` (misal `kep-app-produksi-202611`), supaya tanggal rotasi terlihat.
3. **Scopes** — tambahkan HANYA:
   - `data.records:read` (membaca baris),
   - `data.records:write` (membuat/mengubah baris; aplikasi tidak punya kode hapus).
   - **Jangan** tambahkan `schema.bases:read`: aplikasi tidak memanggil API metadata (semua ID field ditulis
     di kode, `src/lib/airtable/schema.ts`). Tanpa scope ini, token yang bocor juga tidak bisa memetakan struktur base.
   - **Jangan** tambahkan `schema.bases:write`, `data.recordComments:*`, `webhook:manage`, atau scope lain.
4. **Access** — pilih **hanya base "BPK Bandung"**. Jangan pilih "All current and future bases".
5. Klik **Create token**, salin token (diawali `pat…`). Token hanya tampil sekali.
6. Simpan di Vercel sebagai `AIRTABLE_TOKEN` (bagian 3). Jangan kirim lewat chat/email, jangan simpan di file repo.

Keterbatasan yang diterima: izin Airtable berlaku per base, bukan per tabel, jadi token ini bisa membaca seluruh
base (termasuk data kepengurusan BPK). Mitigasinya di aplikasi: allowlist baca dan tulis per field
(`READ_ALLOWED`/`ALLOWED` di `schema.ts`); field di luar daftar dibuang sebelum sampai ke kode lain atau browser.

### Rotasi token tiap 90 hari (pasang pengingat di kalender)

1. Buat token baru (langkah di atas, nama dengan bulan baru).
2. Vercel → Project → Settings → Environment Variables → `AIRTABLE_TOKEN` → Edit → tempel token baru → Save
   (untuk Production dan Preview).
3. Vercel → Deployments → deployment Production terakhir → **Redeploy** (variabel baru hanya terbaca setelah deploy ulang).
4. Buka aplikasi, login, buka daftar KEP: pastikan data tampil.
5. Kembali ke <https://airtable.com/create/tokens> → token lama → **Delete/Revoke**.
6. Catat tanggal rotasi.

---

## 2. Upstash (wajib di produksi)

1. Daftar di <https://console.upstash.com> → **Create Database** (Redis), region terdekat (Singapore), tipe Regional.
2. Di halaman database, bagian **REST API**, salin `UPSTASH_REDIS_REST_URL` (https://…) dan `UPSTASH_REDIS_REST_TOKEN`.
3. Simpan keduanya di Vercel (bagian 3).

Perilaku (sengaja "gagal tertutup"):
- **Produksi tanpa Upstash**: aplikasi menolak melayani — setiap halaman/API menjawab **503** "Layanan belum
  dikonfigurasi". Di log Vercel tertulis nama variabel yang kurang (tanpa nilainya). Tidak pernah diam-diam
  memakai memori per-proses.
- **Upstash sedang gangguan**: semua login/aksi yang dibatasi menjawab **429**, dan **semua sesi dianggap keluar
  (401)** — semua pengguna harus login ulang setelah Upstash pulih. Ini harga dari logout di sisi server yang aman.
  Cek status di <https://status.upstash.com>.

---

## 3. Variabel lingkungan Vercel

Vercel → Project → **Settings → Environment Variables**. Isi untuk **Production** dan **Preview** (preview memakai
`NODE_ENV=production` juga, jadi aturan wajibnya sama). Setelah mengubah variabel: **Redeploy**.

Jika satu variabel wajib kosong/salah, aplikasi menjawab 503 dan log menyebut namanya.

| Nama | Wajib? | Dari mana | Contoh format |
|---|---|---|---|
| `AIRTABLE_TOKEN` | Wajib | Bagian 1 | `patXXXXXXXXXXXXXX.xxxxxxxx…` |
| `AIRTABLE_BASE_ID` | Tidak (bawaan `appIGR8Duhj3Vsz48`) | URL base Airtable | `appIGR8Duhj3Vsz48` |
| `AIRTABLE_API_URL` | **Jangan diisi** di Vercel | Hanya untuk uji lokal | — (diisi di produksi → 503) |
| `SESSION_SECRET` | Wajib, ≥ 32 karakter | `openssl rand -base64 48` | `q3V…` (64 karakter) |
| `MFA_ENC_KEY` | Wajib, tepat 32 byte base64 | `openssl rand -base64 32` | 44 karakter diakhiri `=` |
| `REG_TOKEN_SECRET` | Wajib, ≥ 32 byte | `openssl rand -base64 48` | `Zk9…` |
| `APP_BASE_URL` | Wajib, https, tanpa path | Domain aplikasi | `https://kep.keuskupanbandung.org` |
| `GOOGLE_CLIENT_ID` | Untuk login Google | Google Cloud Console (bagian 4) | `1234-abc.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Untuk login Google | Google Cloud Console | `GOCSPX-…` |
| `GOOGLE_REDIRECT_BASE` | Untuk login Google; **harus sama** dengan `APP_BASE_URL` | Domain aplikasi | `https://kep.keuskupanbandung.org` |
| `UPSTASH_REDIS_REST_URL` | Wajib, https | Bagian 2 | `https://apn1-xxxx.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | Wajib | Bagian 2 | `AX…` |
| `TURNSTILE_SITE_KEY` | Wajib agar form pendaftaran tampil | Cloudflare → Turnstile → Add site | `0x4AAAAAAA…` |
| `TURNSTILE_SECRET` | Wajib agar pendaftaran bisa dikirim (kosong = selalu ditolak) | Cloudflare Turnstile | `0x4AAAAAAA…` |
| `RESEND_API_KEY` | Wajib agar email (undangan, reset, konfirmasi) terkirim | <https://resend.com> → API Keys (izin "Sending access" saja) | `re_…` |
| `MAIL_FROM` | Disarankan | Domain pengirim yang sudah diverifikasi di Resend | `KEP Keuskupan Bandung <kep@keuskupanbandung.org>` |
| `REG_MIN_RESPONSE_MS` | Tidak (bawaan 6000) | — | `6000` (ms; menyamakan waktu jawab "baru"/"sudah terdaftar") |
| `ABSEN_RECHECK_MS` | Tidak (bawaan 0 = mati) | — | `0`; > 0 menambah satu baca ulang tertunda per tap (biaya Airtable 2x) |
| `AIRTABLE_MAX_RPS` | Tidak (bawaan 4, maks. 5) | — | `4` (permintaan Airtable per detik **per instance**; nilai > 5 dipotong ke 5) |
| `AIRTABLE_QUEUE_MAX` | Tidak (bawaan 40) | — | `40` (antrean permintaan per instance; penuh → 503 + Retry-After) |
| `AIRTABLE_MAX_WAIT_MS` | Tidak (bawaan 30000) | — | `30000` (maks. tunggu satu permintaan: antrean + jeda 429 + ulang) |
| `AIRTABLE_429_PAUSE_MS` | Tidak (bawaan 30000) | — | Jeda seluruh proses setelah 429 bila Airtable tidak mengirim `Retry-After` |
| `IMPORT_BUDGET_MS` | Tidak (bawaan 240000) | — | Batas waktu impor Excel; baris sisanya diminta diunggah ulang |
| `ABSEN_SEMUA_BUDGET_MS` | Tidak (bawaan 45000) | — | `45000` (batas waktu "Tandai semua hadir" per panggilan) |
| `KEP_E2E_MODE` | **Jangan pernah diisi** di server sungguhan | Hanya Playwright lokal/CI | — (hanya berlaku bila `AIRTABLE_API_URL` dan `APP_BASE_URL` loopback dan tanpa `VERCEL`/`VERCEL_ENV`/`VERCEL_URL`; selain itu di produksi → 503) |

Catatan Resend (penting):
- Verifikasi domain pengirim (Resend → Domains → Add → pasang record DNS SPF/DKIM yang diminta).
- **Matikan Click tracking dan Open tracking** untuk domain itu. Link undangan/reset berisi token sekali pakai; jika
  tracking aktif, Resend menyimpan dan mengalihkan link tersebut.

Catatan Turnstile: di Cloudflare Turnstile, tambahkan domain produksi (dan domain preview bila perlu) ke daftar hostname.

---

## 4. Google OAuth (login Google)

1. <https://console.cloud.google.com> → buat project `kep-keuskupan-bandung`.
2. **APIs & Services → OAuth consent screen**: User type External; nama aplikasi; email dukungan; scope hanya
   `openid` dan `email`. Publish.
3. **Credentials → Create credentials → OAuth client ID** → Application type **Web application**.
4. **Authorized redirect URIs**: tepat `https://<domain-anda>/api/auth/google/callback`
   (contoh `https://kep.keuskupanbandung.org/api/auth/google/callback`). Tidak boleh ada yang lain.
5. Salin Client ID dan Client secret ke Vercel (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), `GOOGLE_REDIRECT_BASE` =
   `APP_BASE_URL`.

Login Google pertama hanya mengikat akun untuk alamat `@gmail.com`/`@googlemail.com` atau domain Google Workspace
yang cocok (klaim `hd`). Pengguna lain memakai email+password+MFA, lalu "Hubungkan Google" dari halaman Profil.

---

## 5. Membuat akun SEP pertama (bootstrap)

Repo **tidak** punya skrip bootstrap; akun dibuat SEP dari aplikasi, jadi SEP pertama dibuat manual satu kali:

1. Pastikan Resend sudah jalan (bagian 3) dan aplikasi sudah ter-deploy.
2. Di Airtable, tabel **AkunKEP**, tambah satu baris: **Email** = email SEP, **Nama**, **Peran** = `SEP`,
   **Status Aktif** = dicentang. Biarkan **Hash Password**, **ID Google**, **Rahasia MFA** kosong.
3. Buka `https://<domain>/lupa-password`, masukkan email tersebut. Email reset (berlaku 30 menit, sekali pakai) akan masuk.
4. Klik link, buat password (minimal 12 karakter, tidak boleh password yang pernah bocor).
5. Login → aplikasi meminta pendaftaran MFA (scan QR dengan Google Authenticator/Authy, masukkan kode).
6. Mulai sekarang, akun lain (PIC, Admin, SEP lain) dibuat dari menu **Akun** di aplikasi. Membuat SEP baru meminta
   kode MFA terbaru dari SEP yang membuat.
7. Laporkan ke Timmy bahwa satu baris AkunKEP dibuat manual (bukan tabel/field baru, cukup catatan).

Disarankan selalu ada **minimal dua SEP aktif** (aplikasi menolak menonaktifkan SEP aktif terakhir).

## 6. Pemulihan MFA (HP hilang / ganti HP)

- **PIC/Admin/SEP lain**: SEP membuka **Akun** → pilih akun → **Reset MFA** (diminta kode MFA SEP sendiri). Semua sesi
  akun itu otomatis tidak berlaku. Saat login berikutnya pengguna mendaftar MFA ulang.
- **Satu-satunya SEP kehilangan HP**: tidak bisa lewat aplikasi. Di Airtable AkunKEP, baris SEP itu: kosongkan
  **Rahasia MFA** dan **Langkah TOTP Terakhir**. Catat tindakan ini di AuditKEP secara manual (Aksi `mfa_reset_manual`,
  Pelaku = email Anda). Lalu login dan daftar MFA ulang.
- **Admin tanpa password** (masuk hanya dengan Google) tidak bisa mendaftar MFA sendiri: SEP mengirim undangan ulang
  (Nonaktifkan → Aktifkan kembali mengirim undangan baru), Admin membuat password, lalu mendaftar MFA dari Profil.

## 7. Mencabut akses

| Situasi | Langkah | Efek |
|---|---|---|
| Satu sesi dicuri (HP hilang, masih login) | Pengguna (atau siapa saja dengan HP itu) klik **Keluar**; atau SEP **Nonaktifkan** akun | Logout menaruh ID sesi di daftar tolak Upstash. Nonaktif: semua sesi mati ≤ 60 detik |
| Pegawai berhenti | SEP: Akun → **Nonaktifkan** | Tidak bisa login; sesi mati ≤ 60 detik; link undangan/reset lama mati |
| Akun Google salah terhubung | SEP: Akun → **Lepas Google** (kode MFA SEP) | Sesi akun itu tidak berlaku; tautkan ulang dari Profil |
| Password bocor | Pengguna: Lupa password → set baru | Semua sesi lama tidak berlaku |
| Semua orang harus keluar sekarang | Ganti `SESSION_SECRET` di Vercel → Redeploy | Semua sesi, pra-otentikasi, dan link undangan/reset yang beredar mati |
| Link pendaftaran peserta tersebar | PIC: halaman KEP → **Buat tautan baru** | Link lama ditolak. Semua link semua KEP: ganti `REG_TOKEN_SECRET` |
| Token Airtable bocor | Bagian 1: buat token baru, ganti di Vercel, redeploy, **revoke** token lama segera | — |
| Kunci Upstash bocor | Upstash → database → Reset password/token → ganti di Vercel → redeploy | Semua sesi dianggap keluar sesaat |

Catatan: mencabut link pendaftaran bergantung pada baris AuditKEP `link_daftar_rotasi`. Jika seorang kolaborator
Airtable menghapus baris itu, link lama hidup lagi — jangan hapus baris AuditKEP.

## 8. Pemindaian rahasia di riwayat git

CI menjalankan gitleaks pada setiap push (seluruh riwayat). Untuk memeriksa manual di komputer:

```bash
# instal: https://github.com/gitleaks/gitleaks#installing (brew install gitleaks / unduh rilis)
cd kep-keuskupan-bandung
gitleaks git --redact -v .          # gitleaks v8.19+ (seluruh riwayat git)
# versi lebih lama:
gitleaks detect --source . --redact -v --log-opts="--all"
```

Jika ada temuan: anggap rahasia itu bocor → **rotasi dulu** (bagian 7), baru bersihkan riwayat. Menghapus dari riwayat
saja tidak cukup karena salinan repo/fork mungkin sudah ada.

Repo milik **organisasi** GitHub: gitleaks-action membutuhkan lisensi gratis dari <https://gitleaks.io> yang disimpan
sebagai secret `GITLEAKS_LICENSE`. Repo milik akun pribadi tidak perlu. Aktifkan juga GitHub **Settings → Code
security → Secret scanning** dan **Dependabot alerts**.

## 9. Batas waktu fungsi Vercel (maxDuration)

| Route | Kebutuhan | Disetel di kode |
|---|---|---|
| `POST /api/daftar/[token]` | Jawaban ditahan `REG_MIN_RESPONSE_MS` (6 s) + ±12 panggilan Airtable → butuh **≥ 7 s** | `maxDuration = 30` |
| `POST /api/kep/[id]/absen/[sid]/semua` | Maks 60 peserta per panggilan, anggaran 45 s | `maxDuration = 60` |
| `POST /api/kep/[id]/import/commit` | Maks. **100 baris** per berkas; terburuk ±7 panggilan Airtable per baris (cache hangat) → ±703 panggilan ≈ 176 s pada 4 req/s; `IMPORT_BUDGET_MS` 240 s menghentikan baris baru sebelum batas | `maxDuration = 300` |

Pastikan paket Vercel Anda mengizinkan durasi tersebut (Settings → Functions; Fluid Compute disarankan aktif). Jika
paket membatasi lebih pendek, unggah Excel dalam beberapa file lebih kecil (mis. ≤ 50 baris untuk 120 s) dan ulangi "Tandai semua" sampai
sisa = 0 (UI sudah melakukannya otomatis).

## 10. Cadangan (backup)

Aplikasi hanya memakai Airtable; cadangkan base:
1. Mingguan: Airtable → base BPK Bandung → setiap tabel yang dipakai (EventKEP, Events, SubEvent, Pendaftaran Events,
   MasterData TeamUmat, AkunKEP, AuditKEP, Data Pengajar KEP, Pengelenggara KEP) → **Download CSV**. Simpan di folder
   terenkripsi milik BPK (bukan folder bersama publik). File ini berisi data pribadi dan data kesehatan.
2. Airtable menyimpan riwayat revisi dan snapshot base (paket berbayar): base → ikon riwayat → **Snapshots**. Buat
   snapshot manual sebelum operasi besar (misal skrip pemetaan data lama).
3. AkunKEP berisi hash password dan rahasia MFA terenkripsi: perlakukan cadangannya sebagai rahasia.

## 11. Langkah saat insiden

1. **Tahan**: jika ada dugaan pembobolan, nonaktifkan akun terkait (bagian 7). Bila perlu, matikan sementara
   aplikasi: Vercel → Settings → kosongkan sementara `SESSION_SECRET` lalu redeploy (aplikasi menjawab 503).
2. **Rotasi** rahasia yang mungkin terekspos: `AIRTABLE_TOKEN`, `SESSION_SECRET`, `REG_TOKEN_SECRET`, Upstash, Resend,
   Google client secret. **Jangan** ganti `MFA_ENC_KEY` tanpa rencana: semua MFA harus didaftar ulang (reset MFA semua akun).
3. **Periksa** AuditKEP (siapa, aksi apa, kapan) dan log Vercel (Deployments → Functions/Logs).
4. **Pulihkan** data dari riwayat revisi Airtable/snapshot.
5. **Lapor**: kebocoran data pribadi wajib diberitahukan menurut UU No. 27/2022 (PDP) — kepada subjek data dan lembaga
   terkait paling lambat 3 × 24 jam sejak diketahui. Catat kronologi.
6. Tulis catatan singkat insiden dan perbaikannya.

## 12. Perlindungan data (UU PDP) dan kolaborator Airtable

- **Setiap kolaborator base BPK Bandung bisa membaca SEMUA data**, termasuk data kesehatan peserta, kontak darurat,
  nomor HP, dan AkunKEP. Pembatasan per paroki hanya ada di aplikasi, **bukan** di Airtable.
- Batasi kolaborator base seminimal mungkin; gunakan peran "Read only" bila cukup; tinjau daftar kolaborator tiap
  3 bulan (base → Share → kelola).
- Kolaborator bisa menghapus baris (termasuk AuditKEP) — aplikasi tidak bisa mencegahnya. Minta kolaborator tidak
  mengubah tabel aplikasi secara manual kecuali mengikuti runbook ini.
- Data kesehatan hanya diminta bila perlu untuk retret, opsional, dengan persetujuan peserta; hanya PIC/Admin paroki
  yang bersangkutan yang melihatnya di aplikasi (SEP tidak).
- **Layar data kesehatan** `/kep/<id>/kesehatan` (tautan "Data kesehatan peserta" di halaman KEP, hanya PIC/Admin paroki
  itu): daftar peserta yang mengisi catatan kesehatan atau kontak darurat (peserta mundur tampil redup; Batal dan
  Panitia tidak). SEP dialihkan, paroki lain 404 (juga bila acara dipakai bersama KEP paroki lain). Respons
  `Cache-Control: no-store` (diatur di `next.config.ts`). Setiap pembukaan dicatat di AuditKEP sebagai
  `data_kesehatan_dilihat` (hanya id baris, tanpa nama atau isi), maksimal sekali per 10 menit per akun dan KEP
  (penanda di Upstash `kep:rl:...`; bila Upstash tak terjangkau, setiap pembukaan dicatat). Gagal mencatat audit =
  halaman tidak ditampilkan. Tombol "Cetak" memakai CSS cetak A4 tanpa navigasi. Biaya: 3 permintaan Airtable
  pertama, 1 pada muat ulang dalam 10 menit.

## 13. Skrip pemetaan data lama (`pnpm map-legacy`)

Fungsi: satu kali merapikan data KEP lama agar terbaca dashboard — (a) menyalin jadwal BabKEP lama menjadi baris
SubEvent, (b) mengisi EventKEP.Events bila tepat satu Events cocok (paroki + angkatan), (c) mengisi
Pengelenggara KEP.Paroki bila nama paroki cocok persis. Hanya mengisi field kosong / membuat baris baru; tidak pernah
menghapus. Absensi per bab lama dan lampiran **tidak** dipindahkan.

Gerbang pengaman (tidak bisa dilewati):
1. Bawaan **dry-run**: membaca dan menulis `reports/legacy-mapping.csv`, tidak menulis ke Airtable.
2. Pemilik meninjau CSV dan memberi **persetujuan tertulis**.
3. Buat snapshot base (bagian 10).
4. Baru jalankan: `MAP_LEGACY_ACTOR_EMAIL=<email-anda> pnpm map-legacy --apply --confirm=YA --expect-hash=<hash dari dry-run>`.
   Tanpa `--confirm=YA`, tanpa email pelaku, dengan hash berbeda (data berubah sejak dry-run), atau dari snapshot → ditolak.
5. Setiap penerapan dicatat di AuditKEP; menjalankan ulang aman (`--rerun` dengan hash baru).

## 14. Asumsi keamanan yang perlu diketahui

- **IP klien**: pembatas per IP memakai `X-Real-IP`/`X-Forwarded-For`. Ini **hanya benar di Vercel** (Vercel menimpa
  header tersebut). Jika aplikasi dipindah ke server sendiri/proxy lain, proxy harus menghapus dan mengisi ulang header
  itu; kalau tidak, batas per IP bisa diakali (batas per akun/email/link tetap berlaku).
- **Cek asal permintaan (CSRF)**: setiap POST/PATCH harus dari halaman aplikasi sendiri (header `Origin` dan/atau
  `Sec-Fetch-Site: same-origin`) dengan tipe konten JSON (unggah Excel: multipart). Asal dibandingkan dengan host yang
  diterima Vercel, jadi domain kustom dan setiap URL preview masing-masing hanya menerima dirinya sendiri; halaman
  preview tidak bisa mengirim ke produksi. Jika suatu proxy di depan Vercel mengganti header Host, semua POST akan
  ditolak (gagal tertutup) — perbaiki proxy-nya, jangan longgarkan cek.
- **Upstash gangguan = semua sesi 401** (bagian 2).
- Sesi: 15 menit bergeser, maksimal 8 jam; logout dicatat di Upstash.

## 15. Batasan yang diketahui (diterima)

- Token Airtable menjangkau seluruh base (bagian 1); kolaborator Airtable melihat semua data (bagian 12).
- Kode MFA "step-up" (aksi SEP berdampak besar) tidak dipakai secara atomik: dua permintaan bersamaan dengan kode yang
  sama bisa lolos keduanya (Airtable tidak punya penulisan bersyarat). Dibatasi 5 percobaan/15 menit dan butuh sesi SEP.
- Pengikatan Google pertama punya celah balapan sangat kecil (diterima; hanya untuk domain yang dijamin Google).
- Kunci anti-dobel (pembuatan KEP, keputusan, impor, absensi per peserta) bersifat per instance server, bukan lintas
  instance; Airtable menjadi pemutus akhir.
- Cache baca Airtable per proses (cakupan KEP/penyelenggara 45 s, peserta per KEP 15 s, nama acara 10 menit).
  Penulisan lewat aplikasi langsung membatalkan cache di proses itu; instance lain dan perubahan langsung di Airtable
  tampil setelah TTL. Keputusan yang bergantung status (keputusan SEP, kunci jadwal) selalu membaca ulang EventKEP.
- Batas Airtable 5 permintaan/detik **per base** (dibagi dengan integrasi BPK lain; 429 = jeda ±30 s untuk seluruh
  base). Setiap proses aplikasi membatasi diri ke `AIRTABLE_MAX_RPS` (4/s, jendela geser), menjeda seluruh proses saat
  429 sesuai `Retry-After`, dan menolak dengan 503 + Retry-After bila antrean penuh atau tunggu > 30 s (antrean absen
  offline mengulang otomatis; 503 tidak pernah dibuang). Pembatas ini **per instance**: N instance hangat bisa mencapai
  N × 4/s. Untuk acara besar, batasi Vercel "Max Instances" atau turunkan `AIRTABLE_MAX_RPS`.
- Biaya per jalur (diukur di tests/kep/airtable-calls.test.ts pada ukuran base live): lembar absen 6 (dingin) / 1
  (hangat); satu tap absen 4; "Tandai semua" 40 peserta 15; hub KEP 7 / 1; pendaftaran 10 / 7.
- Halaman statistik publik tidak pernah menunggu Airtable: angka dari memori proses atau Upstash (maks. 24 jam);
  instance dingin menampilkan teks cadangan dan menyegarkan di latar (maks. 5 penyegaran per IP per 10 menit).
- Batas baca: GET API dan halaman aplikasi berbagi 600/10 menit per akun (lebih → 429 / halaman `/batas`), halaman
  pendaftaran 120/10 menit per IP dan 600/10 menit per link, pendaftaran 10/jam per IP.
- Sesi 15 menit geser: halaman yang dibuka diperpanjang oleh ping `/api/sesi/ping` tiap 5 menit selama tab terlihat
  dan ada aktivitas (klik/tombol) dalam 5 menit terakhir; tidak pernah melewati batas 8 jam. Tab diam → keluar.
- Pencabutan link pendaftaran bergantung pada baris AuditKEP (bagian 7).
- **Jadwal (tanggal/jam pertemuan)**: PIC paroki (saat KEP Diajukan atau Disetujui; pewarta tetap terkunci setelah
  disetujui) dan SEP (selain Ditolak) mengubah Tanggal, Jam Mulai, Jam Selesai satu pertemuan lewat
  `POST /api/kep/<id>/subevent/<sid>/jadwal` (halaman Jadwal; Admin Paroki 403). Tanggal harus antara tanggal mulai KEP
  dan satu tahun sesudahnya; jam `JJ:MM` (kedua-duanya atau kosong semua), selesai setelah mulai. Pertemuan tidak pernah
  ditambah, dihapus atau diurutkan ulang. Audit `jadwal_set` (sebelum/sesudah: tanggal dan jam, tanpa data pribadi),
  idempoten per `opId` terikat isi permintaan. Mengubah tanggal pertemuan terakhir otomatis menggeser pembukaan
  penetapan hasil akhir dan pemilihan "Absen hari ini". Batas 120 per 10 menit per akun; biaya 5 permintaan Airtable.
- **Peserta datang langsung** (layar Absen, tombol "+ Tambah peserta", `POST /api/kep/<id>/absen/<sid>/tambah`): nama
  lengkap + WhatsApp, email opsional; memakai jalur pendaftaran biasa (cari orang dari WA/email, orang yang sudah ada
  tidak pernah diubah), lalu menandai hadir di pertemuan itu. Tanpa data kesehatan (tidak ada persetujuan yang perlu
  dicatat). KEP harus Disetujui; PIC dan Admin paroki sendiri (lihat pertanyaan terbuka 1). **Hanya online**: tanpa
  sinyal muncul pesan, tidak diantre. Berbagi batas 60 per 10 menit dengan input peserta manual. Audit
  `peserta_walkin_daftar` (id saja) dan `absen_set`. Biaya sekitar 11 permintaan Airtable. Di halaman KEP, peserta yang
  email atau tanggal lahirnya belum ada diberi tanda "Data belum lengkap" (hanya tanda dan jumlah; belum ada layar
  untuk melengkapi, lengkapi langsung di Airtable atau lewat pendaftaran ulang oleh orang itu sendiri).
- Cache akun sesi (60 detik; dicabut langsung saat nonaktif/ganti peran/ganti password) kini satu per proses, dipakai
  bersama oleh bundel API dan bundel halaman (`globalThis`). Di instance lain pencabutan tetap menunggu sampai 60 detik.
- Tanpa `RESEND_API_KEY` email tidak terkirim (hanya dicatat di log).

---

## 16. Pertanyaan terbuka untuk pemilik — "Hak Admin Paroki"

Mohon konfirmasi tertulis (jawaban mengubah matriks `tests/security/matrix.ts`):

1. **Tambah peserta manual oleh Admin**: API saat ini mengizinkan Admin Paroki (sesuai §8b.8 "peserta datang langsung"
   di layar absen), padahal §6 menulis "kelola peserta" hanya untuk PIC. Spesifikasi diam soal siapa yang boleh memakai
   tombol "+ Tambah peserta" (§8b menyebut layar Absen = layar Admin, dan "PIC melengkapi datanya kemudian"); sekarang
   PIC dan Admin keduanya boleh. Tetap izinkan Admin? Dan siapa yang melengkapi data peserta datang langsung (belum ada
   layar sunting)?
2. **Unduh laporan paroki oleh Admin**: saat ini Admin boleh melihat/mengunduh laporan parokinya sendiri; §6 menulis
   "laporan paroki" hanya untuk PIC. Tetap izinkan?
3. **Data kesehatan**: Admin paroki yang bersangkutan dapat melihat data kesehatan peserta (sesuai §4). Benar?
4. **MFA Admin opsional**: Admin yang belum mendaftar MFA dan login dengan Google langsung masuk tanpa kode
   (yang sudah mendaftar MFA tetap dimintai kode). Diterima?
5. **Admin tanpa password** tidak bisa mendaftar MFA sendiri (harus diundang ulang SEP). Diterima?
6. **Kunjungan rumah** dicatat sebagai kehadiran pada pertemuan "Kunjungan rumah" di jadwal, bukan field tersendiri. Cukup?
7. Pertanyaan lain yang masih terbuka di catatan proyek: jadwal 28 pertemuan vs "27" di spesifikasi; apakah acara
   "KEP Exe" ikut dihitung; nama lembaga di footer landing.
