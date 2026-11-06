# Aplikasi KEP Keuskupan Bandung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web app mobile-first untuk pendataan dan pelaksanaan KEP di Keuskupan Bandung (landing publik, login, persetujuan SEP, pendaftaran peserta, absensi per pertemuan, dashboard), dengan data tetap di Airtable.

**Architecture:** Next.js (App Router, TypeScript) di Vercel; semua akses Airtable lewat server (token tidak pernah ke browser) melalui satu klien tipis dengan allowlist field dan tanpa fungsi hapus. Otorisasi peran dan paroki dipaksa di server. Absensi = tautan di kolom "Pertemuan Hadir" (Pendaftaran Events › SubEvent), bukan baris baru.

**Tech Stack:** Next.js + TypeScript, Vitest, Playwright, zod, `@node-rs/argon2`, `jose` (JWT sesi), `otplib` (TOTP), Resend (email), Cloudflare Turnstile (captcha), Upstash Redis (`@upstash/ratelimit`), `exceljs` (xlsx), pnpm.

**Spec:** `docs/superpowers/specs/2026-11-06-aplikasi-kep-design.md` (disetujui pengguna 2026-11-06). Repo kode: repo GitHub milik pengguna, namanya dikonfirmasi di Task 1.

## Global Constraints

- Base Airtable: `appIGR8Duhj3Vsz48` (BPK Bandung). Dilarang menghapus tabel yang sudah ada; aplikasi tidak punya kode hapus (peserta dibatalkan lewat Status Pendaftaran "Batal").
- Setiap tabel atau field baru di Airtable: laporkan ke pengguna dan kirim email ke timmy.theopelus@gmail.com. Pembuatan tabel/field dan migrasi data hanya setelah persetujuan eksplisit pengguna.
- Hanya email yang sudah dibuat SEP di AkunKEP yang boleh login; Google: `email_verified` harus true.
- Password: Argon2id, minimal 12 karakter, dicek ke daftar password bocor. Reset password: link sekali pakai, berlaku 30 menit.
- MFA (TOTP) wajib untuk SEP dan PIC Paroki; opsional untuk Admin Paroki.
- Cookie sesi `HttpOnly; Secure; SameSite=Lax`; CSRF dilindungi; CSP ketat; HSTS.
- Hak akses di server: Admin Paroki = absensi/mundur/lulus/tambah peserta; PIC Paroki = hak Admin + buat KEP, ajukan pewarta, kelola peserta; SEP = lihat se-keuskupan, setujui/tolak, kelola akun, ubah bio/YouTube pewarta. Data paroki lain tidak boleh terbaca.
- Allowlist field: field di MasterData TeamUmat di luar daftar putih (data kepengurusan BPK, dll.) tidak boleh dibaca/ditulis/dikirim ke browser.
- Token Airtable: izin minimal (baca/tulis data saja, tanpa ubah skema, tanpa hapus).
- Form publik: Turnstile + rate limit per IP; link pendaftaran = token bertanda tangan dari ID acara.
- Unggah Excel: hanya `.xlsx`, tanpa makro, batas ukuran, sel berawalan `=`, `+`, `-`, `@` dinetralkan.
- Tampilan mobile-first (HP utama); target ketuk minimal 56 px pada layar Absen; layar Absen tampil < 1 detik di jaringan seluler.
- Kesaksian alumni: nama dan foto hanya tampil jika ada izin (`consent: true`); selain itu kutipan saja.
- Nomor HP pewarta hanya terlihat PIC Paroki setelah pewarta disetujui untuk KEP paroki itu; SEP selalu bisa melihat.

## Review Focus

1. Pengguna paroki A mengubah ID/URL ke KEP paroki B: harus ditolak di server (Task 7, 15).
2. Orang yang sama mendaftar dua kali (WA atau email sama, format berbeda seperti `0812…` vs `+62812…`, huruf besar/kecil): tidak membuat orang ganda atau pendaftaran ganda (Task 13).
3. Excel dengan formula (`=HYPERLINK(...)`), baris kosong, kolom salah, file besar, atau `.xlsm`: ditolak atau dinetralkan, tidak ada yang tertulis sebagian tanpa pratinjau (Task 14).
4. Ketuk Hadir dua kali cepat, kirim ulang setelah offline, dan dua Admin di KEP yang sama: hasil akhir benar, idempoten, tidak ada baris ganda, dan tercatat di AuditKEP (Task 15, 16).
5. Data lama kotor (acara KEP ganda, paroki belum terpetakan, acara non-kursus berkelompok "KEP", peserta berstatus Daftar tetapi LULUS): dashboard tidak error dan tidak salah hitung (Task 9, 17, 18).

---

## File Structure

```
app/                         # halaman dan route handlers (tipis; logika di lib/)
  (public)/page.tsx          # landing
  (public)/daftar/[token]/   # form pendaftaran peserta
  (app)/login/ (app)/kep/ (app)/pewarta/ (app)/dashboard/ (app)/akun/
  api/...                    # route handlers
lib/airtable/{client.ts,schema.ts}     # satu-satunya pintu ke Airtable
lib/auth/{password.ts,totp.ts,session.ts,google.ts,lockout.ts,guard.ts}
lib/kep/{readModel.ts,template.ts,create.ts,approval.ts,registration.ts,absensi.ts,import.ts,reports.ts}
lib/pewarta/{profile.ts,youtube.ts}
lib/mail/{send.ts,templates.ts}  lib/audit/log.ts  lib/security/{ratelimit.ts,turnstile.ts,csv.ts}
content/{landing.ts,testimonials.ts}
scripts/map-legacy.ts
tests/ (unit, mirrors lib/)   e2e/ (Playwright)
```

---

### Task 1: Scaffold, CI, dan pengamanan repo

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts` (header keamanan), `vitest.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.gitignore`, `.env.example`
- Test: `tests/security/headers.test.ts`

**Interfaces:**
- Produces: perintah `pnpm test` (Vitest), `pnpm e2e` (Playwright, viewport default 390×844), `pnpm lint`; `.env.example` berisi nama variabel: `AIRTABLE_TOKEN`, `SESSION_SECRET`, `MFA_ENC_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, `TURNSTILE_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `REG_TOKEN_SECRET`.

- [ ] **Step 1:** Tanyakan nama repo GitHub pengguna dan clone/inisialisasi; buat proyek Next.js TypeScript dengan pnpm.
- [ ] **Step 2: Test gagal** `headers.test.ts`: `GET /` mengembalikan `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, dan `Content-Security-Policy` yang tidak mengandung `unsafe-eval` dan membatasi `frame-src` ke `https://www.youtube-nocookie.com` dan Turnstile.
- [ ] **Step 3:** Implementasi header di `next.config.ts` (fungsi `headers()`), `ci.yml` (lint, test, e2e, gitleaks, `pnpm audit`), `dependabot.yml`, dan pastikan `.env*` kecuali `.env.example` ada di `.gitignore`.
- [ ] **Step 4:** Jalankan `pnpm test tests/security/headers.test.ts` → PASS; CI hijau di GitHub.
- [ ] **Step 5: Commit** `chore: scaffold app, ci, security headers`.

### Task 2: Klien Airtable dengan allowlist dan tanpa hapus

**Files:**
- Create: `lib/airtable/client.ts`, `lib/airtable/schema.ts`
- Test: `tests/airtable/client.test.ts`, `tests/airtable/schema.test.ts`

**Interfaces:**
- Produces (`schema.ts`): `T` (ID tabel) dan `F` (ID field) dari tabel di bawah; `ALLOWED: Record<tableId, Set<fieldId>>`; `pickAllowed(tableId: string, fields: Record<string, unknown>): Record<string, unknown>` (membuang field di luar allowlist).
- Produces (`client.ts`): `listRecords(tableId: string, opts: { fields: string[]; filterByFormula?: string; sort?: {field: string; direction: 'asc'|'desc'}[]; maxRecords?: number }): Promise<AtRecord[]>` (paginasi otomatis); `getRecord(tableId, id)`; `createRecords(tableId, rows: Record<string, unknown>[]): Promise<AtRecord[]>` (chunk 10); `updateRecords(tableId, rows: {id: string; fields: Record<string, unknown>}[]): Promise<AtRecord[]>` (chunk 10). Tipe `AtRecord = { id: string; fields: Record<string, unknown> }`.

ID yang sudah ada (dari pembacaan base): tabel `Events tblbAIILkeRIwn3kl`, `Pendaftaran Events tbltiJ1qDJEwfWPLg`, `MasterData TeamUmat tblwRNtXSVzgzVXuk`, `EventKEP tbllEWCLGPMwXnVBT`, `BabKEP tblz5q7GDKGcVksLw`, `Pengelenggara KEP tblH4SN6qpNxJFg35`, `Data Pengajar KEP tblphUIZPACl1BKpS`, `Paroki tbl8sfqU6G47orPpn`, `KehadiranEvent tblQgU4DawCAXIRdi`. Field: Events `Nama Acara fld0d9tIyi4nyTZsM`, `Tanggal Acara fldoIkx9wLMaKOa38`, `Kelompok Acara fldhgv2WlvqytF6zA` (pilihan KEP = `sel89ZKeY5BWQgaTL`), `Lokasi Acara fldY0qw1v0a4fK9Sp`; Pendaftaran Events `Event flduf15moMpZSklGL`, `Team Umat fldqvA9dTUmWLfRr2`, `StatusPendaftaran fldNGGEcwHqIsQPct` (Daftar/Confirmed/Paid & Confirm/Batal/Dobel Daftar), `Kategori Kepesertaan fldIgnkqdrDPz8gCV` (Peserta/Panitia), `Keterangan fld0rpifIKPadBYpe` (LULUS/TIDAK LULUS/MENGUNDURKAN DIRI), `Kontak Darurat fldumrliAbkcLJJsz`, `Riwayat Penyakit fldIDrkKEzyPORmVj`, `Riwayat Alergi fldUDGah0ZmaBUpbC`, `Obat Rutin Dikonsumsi fldMvsFA7aXXLk3ZH`; TeamUmat `Nama Lengkap fldIpQTSkFB9sU0lo`, `Nama Baptis fld0P7TE88KvYXORT`, `Email fldAaQ3zmiLBhp4z9`, `No Whatsapp Aktif fldzY1Z2QvIIEkYXR`, `TanggalLahir fldXGHvqnezzKZSCp`, `Alamat Tinggal fldcQFzBtr9EELTtV`, `Jenis Kelamin fldxpeouH1hcxMzNc`, `StatusPernikahan fldRKWfGerVT5jcnp`, `Paroki fldE62NyXuSJLvM8h`; Data Pengajar `Nama fldYEMM3xGzWnAJuX`, `Status fldi7BZu04g8hHksR` (Aktif), `Photo fldu2pMyDKF9bMTiF`; ID field `NoHP` tidak ditulis di sini: ambil dari `get_table_schema` pada langkah 3 (jangan menebak).

- [ ] **Step 1: Test gagal** `client.test.ts` (fetch di-mock): `listRecords` mengikuti `offset` sampai habis; `createRecords` dengan 25 baris mengirim 3 permintaan (10/10/5); HTTP 429 diulang dengan backoff maksimal 3 kali lalu melempar; `Object.keys(await import('lib/airtable/client'))` tidak ada yang cocok `/delete|destroy|remove/i`. `schema.test.ts`: `pickAllowed(T.teamUmat, {[F.teamUmat.jabatanBPK]: 'x', [F.teamUmat.namaLengkap]: 'A'})` hanya mengembalikan Nama Lengkap.
- [ ] **Step 2:** Jalankan `pnpm test tests/airtable` → FAIL (modul belum ada).
- [ ] **Step 3:** Implementasi sesuai signature; baca `AIRTABLE_TOKEN` hanya dari `process.env` di sisi server (`import 'server-only'`). Verifikasi tiap ID field di atas dengan Airtable MCP `get_table_schema` (hanya baca) sebelum menulisnya ke `schema.ts`.
- [ ] **Step 4:** Jalankan `pnpm test tests/airtable` → PASS.
- [ ] **Step 5: Commit** `feat: airtable client with allowlist and no delete`.

### Task 3: Perubahan skema Airtable (GERBANG PERSETUJUAN)

**Files:**
- Modify: `lib/airtable/schema.ts` (tambah ID baru)
- Create: `docs/airtable-changes.md` (laporan perubahan)

**Interfaces:**
- Produces: ID tabel/field baru di `T`/`F`: tabel `akunKep`, `subEvent`, `auditKep`; field `eventKep.statusPersetujuan`, `eventKep.catatanSep`, `eventKep.events`, `pengelenggara.paroki`, `pendaftaran.pertemuanHadir`, `pendaftaran.pendukungDoa`, `pengajar.linkYoutube`, `pengajar.bioSingkat`.

- [ ] **Step 1: BERHENTI dan minta persetujuan.** Tampilkan daftar tepat (bagian 5 spec) kepada pengguna; jangan membuat apa pun sebelum ada jawaban "ya" eksplisit. Daftar: 3 tabel dan 8 field di tabel yang sudah ada. Tidak ada tabel yang dihapus atau diubah selain penambahan field.
- [ ] **Step 2:** Setelah disetujui, buat lewat Airtable MCP (`create_table`, `create_field`). Pilihan `Status Persetujuan`: Diajukan, Disetujui, Ditolak. `Pertemuan Hadir` = tautan banyak ke SubEvent; `SubEvent.Acara` = tautan ke Events. Field AkunKEP sesuai spec bagian 5.
- [ ] **Step 3:** Verifikasi dengan `list_tables_for_base`/`get_table_schema` bahwa semua ada, tabel lama tidak berkurang (jumlah tabel sebelum + 3), lalu catat ID ke `schema.ts` dan `docs/airtable-changes.md`.
- [ ] **Step 4:** Laporkan ke pengguna di chat dan **kirim email ke timmy.theopelus@gmail.com** berisi isi `docs/airtable-changes.md`. Cari konektor email (`SearchMcpRegistry`); jika tidak ada konektor email, berhenti dan minta pengguna menghubungkan atau mengirimnya sendiri. Jangan menandai langkah ini selesai tanpa bukti terkirim.
- [ ] **Step 5: Commit** `chore: record airtable schema additions`.

### Task 4: Primitif autentikasi

**Files:**
- Create: `lib/auth/password.ts`, `lib/auth/totp.ts`, `lib/auth/lockout.ts`
- Test: `tests/auth/password.test.ts`, `tests/auth/totp.test.ts`, `tests/auth/lockout.test.ts`

**Interfaces:**
- Produces: `hashPassword(pw: string): Promise<string>` (Argon2id), `verifyPassword(hash: string, pw: string): Promise<boolean>`, `validatePasswordPolicy(pw: string): { ok: boolean; reason?: string }` (min 12), `isBreachedPassword(pw: string): Promise<boolean>` (HIBP k-anonymity: kirim 5 karakter pertama SHA-1 saja; jika layanan gagal, **tolak** password baru dengan pesan coba lagi), `generateTotpSecret(): string`, `verifyTotp(secret: string, code: string): boolean` (toleransi ±1 langkah), `encryptSecret(plain: string): string` / `decryptSecret(blob: string): string` (AES-256-GCM, kunci `MFA_ENC_KEY`), `nextFailureState(state: {failed: number; lockedUntil: string | null}, now: Date): {failed: number; lockedUntil: string | null}` (gagal ke-5 mengunci 15 menit), `isLocked(lockedUntil: string | null, now: Date): boolean`.

- [ ] **Step 1: Test gagal:** password 11 karakter ditolak, 12 diterima; hash dua kali pada password sama menghasilkan nilai berbeda dan `verifyPassword` benar/salah; `encryptSecret`→`decryptSecret` bolak-balik, blob yang diubah satu byte melempar error; `verifyTotp` menerima kode saat ini dan menolak kode 3 langkah lalu; gagal ke-4 belum terkunci, gagal ke-5 terkunci hingga now+15 menit, `isLocked` false setelah lewat; HIBP mock mengembalikan cocok → `true`.
- [ ] **Step 2:** `pnpm test tests/auth` → FAIL.
- [ ] **Step 3:** Implementasi sesuai signature (`@node-rs/argon2`, `otplib`, `node:crypto`).
- [ ] **Step 4:** `pnpm test tests/auth` → PASS.
- [ ] **Step 5: Commit** `feat: auth primitives (argon2id, totp, lockout)`.

### Task 5: Sesi dan login email+password dengan MFA

**Files:**
- Create: `lib/auth/session.ts`, `lib/accounts/repo.ts`, `app/api/auth/login/route.ts`, `app/api/auth/mfa/enroll/route.ts`, `app/api/auth/logout/route.ts`, `app/(app)/login/page.tsx`
- Test: `tests/auth/session.test.ts`, `tests/auth/login.test.ts`

**Interfaces:**
- Consumes: Task 2 (`listRecords`, `updateRecords`), Task 4.
- Produces: tipe `Role = 'SEP' | 'PIC' | 'ADMIN'`; `Session = { accountId: string; email: string; role: Role; parokiId: string | null }`; `getAccountByEmail(email: string): Promise<Account | null>` (huruf kecil, hanya status aktif); `issueSession(session: Session): Promise<string>` (JWT HS256, 15 menit, geser hingga maksimal 8 jam); `readSession(cookieHeader: string): Promise<Session | null>` (memeriksa akun masih aktif, cache 60 detik: menonaktifkan akun = mencabut sesi).
- Perilaku `POST /api/auth/login` `{email, password, totp?}`: semua kegagalan (email tak dikenal, password salah, akun nonaktif, terkunci) mengembalikan pesan identik "Email atau password salah" dengan status 401, dan tetap menjalankan verifikasi hash tiruan agar waktu respons serupa; MFA wajib untuk `SEP`/`PIC`: tanpa rahasia MFA terdaftar → `{ next: 'mfa_enroll' }`, ada tetapi `totp` kosong → `{ next: 'mfa' }`.

- [ ] **Step 1: Test gagal:** (a) email tak dikenal dan password salah menghasilkan body dan status identik; (b) 5 password salah mengunci akun walau password benar sesudahnya, dan pesan tetap sama; (c) role `PIC` dengan password benar tanpa `totp` → `next: 'mfa'`; dengan `totp` benar → cookie `kep_session` dengan atribut `HttpOnly`, `Secure`, `SameSite=Lax`; (d) role `ADMIN` login tanpa MFA berhasil; (e) akun dinonaktifkan setelah sesi diterbitkan → `readSession` mengembalikan `null` setelah cache kedaluwarsa; (f) JWT dengan tanda tangan salah ditolak.
- [ ] **Step 2:** `pnpm test tests/auth/session.test.ts tests/auth/login.test.ts` → FAIL.
- [ ] **Step 3:** Implementasi; field AkunKEP dibaca/ditulis lewat `F.akunKep.*`; `jose` untuk JWT; hitung gagal-login ditulis ke AkunKEP (`failed`, `lockedUntil`).
- [ ] **Step 4:** Jalankan tes → PASS.
- [ ] **Step 5: Commit** `feat: password login with mandatory mfa for sep and pic`.

### Task 6: Login Google (SSO)

**Files:**
- Create: `lib/auth/google.ts`, `app/api/auth/google/start/route.ts`, `app/api/auth/google/callback/route.ts`
- Test: `tests/auth/google.test.ts`

**Interfaces:**
- Consumes: Task 5 (`getAccountByEmail`, `issueSession`).
- Produces: `buildGoogleAuthUrl(): { url: string; cookies: {state: string; nonce: string; verifier: string} }` (authorization code + PKCE S256); `completeGoogleLogin(params: { code: string; state: string }, cookies): Promise<{ ok: true; next: 'session' | 'mfa' | 'mfa_enroll'; account: Account } | { ok: false }>`.

- [ ] **Step 1: Test gagal:** `state` tidak cocok → `ok:false`; `nonce` tidak cocok → `ok:false`; `email_verified:false` → `ok:false`; email Google `Budi@Gmail.com` cocok dengan akun `budi@gmail.com` (tidak peka huruf besar/kecil); email tak terdaftar → `ok:false` dengan respons yang sama seperti kegagalan lain (tanpa membocorkan terdaftar atau tidak); akun nonaktif → `ok:false`; peran `SEP`/`PIC` tetap mendapat `next: 'mfa'` setelah Google; `ADMIN` langsung `session`.
- [ ] **Step 2:** `pnpm test tests/auth/google.test.ts` → FAIL.
- [ ] **Step 3:** Implementasi dengan verifikasi ID token (`jose` + JWKS Google, cek `aud`, `iss`, `exp`, `nonce`).
- [ ] **Step 4:** Tes → PASS.
- [ ] **Step 5: Commit** `feat: google sso restricted to registered accounts`.

### Task 7: Otorisasi dan pembatasan paroki

**Files:**
- Create: `lib/auth/guard.ts`
- Test: `tests/auth/guard.test.ts`

**Interfaces:**
- Consumes: Task 5 (`Session`, `Role`), Task 2.
- Produces: `requireSession(req: Request): Promise<Session>` (melempar `HttpError(401)`), `requireRole(session: Session, roles: Role[]): void` (melempar `HttpError(403)`), `assertKepInScope(session: Session, eventKepId: string): Promise<{ eventKep: AtRecord; parokiId: string }>` (SEP lolos semua; PIC/ADMIN hanya jika `Pengelenggara KEP.Paroki` KEP itu = `session.parokiId`; di luar itu melempar `HttpError(404)` agar tidak bisa dipakai menebak ID), `scopeFilter(session: Session): { parokiId: string | 'ALL' }`.

- [ ] **Step 1: Test gagal:** PIC paroki A memanggil `assertKepInScope` untuk KEP milik paroki B → `HttpError(404)`; ADMIN memanggil guard `['SEP','PIC']` → 403; SEP lolos untuk KEP mana pun; sesi tanpa `parokiId` pada peran `PIC`/`ADMIN` → 403 (akun salah konfigurasi tidak boleh melihat semua).
- [ ] **Step 2:** `pnpm test tests/auth/guard.test.ts` → FAIL.
- [ ] **Step 3:** Implementasi; tambah helper `withAuth(handler, {roles})` yang dipakai semua route di tugas berikutnya.
- [ ] **Step 4:** Tes → PASS.
- [ ] **Step 5: Commit** `feat: role and paroki authorization guards`.

### Task 8: Kelola akun oleh SEP dan reset password

**Files:**
- Create: `lib/accounts/manage.ts`, `lib/mail/send.ts`, `lib/mail/templates.ts`, `app/api/akun/route.ts`, `app/api/auth/reset/{request,confirm}/route.ts`, `app/(app)/akun/page.tsx`
- Test: `tests/accounts/manage.test.ts`

**Interfaces:**
- Consumes: Task 4, 5, 7.
- Produces: `createAccount(actor: Session, input: { email: string; nama: string; role: Role; parokiId: string | null }): Promise<Account>` (hanya `SEP`; `PIC`/`ADMIN` wajib `parokiId`; mengirim undangan berisi link atur-password sekali pakai, berlaku 72 jam); `deactivateAccount(actor: Session, accountId: string): Promise<void>`; `requestPasswordReset(email: string): Promise<void>` (selalu selesai tanpa membedakan email ada atau tidak; link berlaku 30 menit); `confirmPasswordReset(token: string, newPassword: string): Promise<void>` (token sekali pakai, kebijakan password Task 4 diterapkan); `sendMail(to: string, template: MailTemplate, data: object): Promise<void>` (Resend).

- [ ] **Step 1: Test gagal:** non-SEP memanggil `createAccount` → 403; peran `PIC` tanpa `parokiId` ditolak; `requestPasswordReset` untuk email tak dikenal tidak melempar dan tidak mengirim email; token kedua kalinya ditolak; token berusia 31 menit ditolak; password 11 karakter ditolak; reset berhasil menyetel ulang hitung gagal login.
- [ ] **Step 2:** Jalankan tes → FAIL.
- [ ] **Step 3:** Implementasi (token reset = JWT bertanda tangan dengan `jti`; penggunaan tercatat di AkunKEP sehingga tidak bisa dipakai ulang).
- [ ] **Step 4:** Tes → PASS.
- [ ] **Step 5: Commit** `feat: sep-managed accounts and password reset`.

### Task 9: Model baca KEP dan statistik publik

**Files:**
- Create: `lib/kep/readModel.ts`
- Test: `tests/kep/readModel.test.ts`, `tests/kep/fixtures/legacy.json`

**Interfaces:**
- Consumes: Task 2, 7.
- Produces: tipe `KepEvent = { eventId: string; eventKepId: string | null; parokiId: string | null; parokiNama: string; angkatan: number | null; tanggalMulai: string | null; status: 'Diajukan' | 'Disetujui' | 'Ditolak' | 'Lama'; pesertaCount: number }`; `listKepEvents(scope: { parokiId: string | 'ALL' }): Promise<KepEvent[]>` (hanya acara kursus: Kelompok Acara = KEP **dan** nama cocok `/^KEP PAROKI/i` atau tertaut ke EventKEP; menyaring "Pembekalan Pengajar KEP", "Bina Lanjut KEP"; duplikat paroki+angkatan digabung ke satu entri dengan pendaftar terbanyak; paroki yang belum terpetakan ditampilkan sebagai "Belum terpetakan"; data lama tanpa persetujuan berstatus `Lama`); `publicStats(): Promise<{ paroki: number; angkatan: number; lulusan: number; daftarParoki: { nama: string; angkatan: number }[] }>` (cache 10 menit; `lulusan` = Pendaftaran Events dengan Keterangan LULUS dan Kategori Peserta; tidak ada nama orang).

- [ ] **Step 1: Test gagal** memakai `legacy.json`: "St. Laurentius Angkatan 18" dua kali → satu entri; "Pembekalan Pengajar KEP" tidak muncul; paroki tak terpetakan → `parokiNama === 'Belum terpetakan'` dan tidak melempar; peserta berstatus Daftar dengan Keterangan LULUS dihitung sebagai lulusan; `publicStats` tidak memuat field bernama orang.
- [ ] **Step 2:** `pnpm test tests/kep/readModel.test.ts` → FAIL.
- [ ] **Step 3:** Implementasi dengan cache memori + `revalidate`.
- [ ] **Step 4:** Tes → PASS.
- [ ] **Step 5: Commit** `feat: kep read model and public stats with legacy cleanup`.

### Task 10: Landing page publik

**Files:**
- Create: `content/landing.ts`, `content/testimonials.ts`, `app/(public)/page.tsx`, komponen di `app/(public)/_components/`
- Test: `tests/content/testimonials.test.ts`, `e2e/landing.spec.ts`

**Interfaces:**
- Consumes: Task 9 (`publicStats`).
- Produces: `visibleTestimonials(items: Testimonial[]): { quote: string; name?: string; photo?: string }[]` dengan `Testimonial = { quote: string; name: string; photo?: string; consent: boolean }` (tanpa `consent`, nama dan foto dibuang, kutipan tetap).

- [ ] **Step 1: Test gagal:** `visibleTestimonials` untuk `consent:false` tidak mengandung `name` maupun `photo`; `consent:true` mengandung keduanya. E2E (viewport 390×844): halaman memuat judul "Apa itu KEP?", angka paroki/angkatan/lulusan, daftar paroki, tombol "Masuk", dan `document.documentElement.scrollWidth <= window.innerWidth` (tanpa scroll horizontal); di viewport 1280 layout melebar tanpa error.
- [ ] **Step 2:** Jalankan tes → FAIL.
- [ ] **Step 3:** Isi `content/landing.ts` dari bagian 10b spec (11 bagian; kutip isi buku dengan kata sendiri atau dari dokumen pengguna sendiri); `testimonials.ts` diisi kutipan buku dengan `consent:false` secara default sampai pengguna menandai izin. Aplikasikan skill `frontend-design` untuk tampilan (identitas BPK: biru tua dan merah muda dari buku).
- [ ] **Step 4:** Tes unit dan e2e → PASS.
- [ ] **Step 5: Commit** `feat: public landing page`.

### Task 11: Buat KEP, jadwal tetap, dan persetujuan SEP

**Files:**
- Create: `lib/kep/template.ts`, `lib/kep/create.ts`, `lib/kep/approval.ts`, `lib/audit/log.ts`, `app/api/kep/route.ts`, `app/api/kep/[id]/decision/route.ts`, `app/(app)/kep/baru/page.tsx`, `app/(app)/kep/antrean/page.tsx`
- Test: `tests/kep/template.test.ts`, `tests/kep/create.test.ts`, `tests/kep/approval.test.ts`

**Interfaces:**
- Consumes: Task 2, 3, 7, 8 (`sendMail`).
- Produces: `KEP_TEMPLATE: { urutan: number; agenda: string }[]` (28 entri: Misa Pembukaan; Bab 1; Bab 2 ×2; Evangelii Nuntiandi ×2; Bab 3 sampai Bab 9 masing-masing ×2; Bab 10 ×2; Maria Bintang Evangelisasi; Iman Katolik; Bab 10 (praktik); Evaluasi Kunjungan rumah; Retreat Pengutusan hari 1; Retreat Pengutusan hari 2; urutan dan jumlah akhir **dikonfirmasi pengguna** sebelum merge, ini keputusan yang ditandai di PR); `scheduleDates(startISO: string): string[]` (mingguan sejak `startISO`; dua entri Retreat berurutan: hari 1 = pertemuan terakhir + 7 hari, hari 2 = +1 hari); `createKep(actor: Session, input: { parokiId: string; angkatan: number; tanggalMulai: string }): Promise<{ eventKepId: string; eventId: string; subEventIds: string[] }>` (`PIC` untuk parokinya sendiri; membuat EventKEP dengan `Status Persetujuan = Diajukan` dan `SubmittedBy = actor.email`, Events dengan `Kelompok Acara = KEP` dan nama `KEP PAROKI {NAMA} ANGKATAN {n}`, semua SubEvent, dan tautan EventKEP↔Events; karena aplikasi tidak boleh menghapus, semua validasi dijalankan sebelum penulisan pertama, dan jika penulisan gagal di tengah, fungsi melaporkan baris mana yang sudah terbuat agar bisa dilanjutkan secara idempoten saat dicoba ulang); `assignPengajar(actor: Session, subEventId: string, pengajarIds: string[]): Promise<void>` (PIC; hanya pewarta Status Aktif); `decideKep(actor: Session, eventKepId: string, decision: 'Disetujui' | 'Ditolak', catatan: string): Promise<void>` (hanya SEP; catatan wajib untuk Ditolak; menulis `Status Persetujuan`, `Catatan SEP`, mencatat audit, dan mengirim email ke `SubmittedBy`); `logAudit(entry: { actorEmail: string; action: string; targetId: string; before?: unknown; after?: unknown }): Promise<void>`.

- [ ] **Step 1: Test gagal:** `KEP_TEMPLATE.length === 28`, urutan pertama "Misa Pembukaan", dua entri terakhir "Retreat Pengutusan"; `scheduleDates('2027-01-01')` mingguan dan dua tanggal terakhir berurutan; ADMIN memanggil `createKep` → 403; PIC paroki A membuat KEP untuk paroki B → 404/403; `createKep` menghasilkan 28 `subEventIds`; `decideKep` oleh PIC → 403; `Ditolak` tanpa catatan → error; keputusan menulis satu entri audit dan mengirim satu email.
- [ ] **Step 2:** Jalankan tes → FAIL.
- [ ] **Step 3:** Implementasi sesuai signature.
- [ ] **Step 4:** Tes → PASS.
- [ ] **Step 5: Commit** `feat: create kep with fixed schedule and sep approval`.

### Task 12: Daftar dan profil pewarta

**Files:**
- Create: `lib/pewarta/profile.ts`, `lib/pewarta/youtube.ts`, `app/(app)/pewarta/page.tsx`, `app/(app)/pewarta/[id]/page.tsx`, `app/api/pewarta/[id]/route.ts`
- Test: `tests/pewarta/profile.test.ts`, `tests/pewarta/youtube.test.ts`

**Interfaces:**
- Consumes: Task 2, 7, 11 (`assignPengajar`).
- Produces: `parseYoutubeId(url: string): string | null` (menerima `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/embed/`; menolak domain lain dan skema non-https); `embedUrl(id: string): string` → `https://www.youtube-nocookie.com/embed/{id}`; `listPewarta(session: Session, q?: { bab?: string; nama?: string }): Promise<PewartaCard[]>` (hanya Status Aktif; tanpa NoHP); `getPewarta(session: Session, id: string): Promise<PewartaDetail>` dengan `noHp` hanya terisi bila `SEP`, atau `PIC` dan pewarta itu ditugaskan pada KEP paroki PIC dengan Status Persetujuan = Disetujui; `updatePewartaProfile(actor: Session, id: string, input: { linkYoutube?: string; bioSingkat?: string }): Promise<void>` (hanya SEP; URL wajib lolos `parseYoutubeId`).

- [ ] **Step 1: Test gagal:** `parseYoutubeId('https://evil.com/watch?v=abc')` → `null`; `javascript:` ditolak; ketiga bentuk URL YouTube valid menghasilkan ID; `listPewarta` tidak pernah memuat `noHp`; PIC melihat `noHp` pewarta hanya setelah KEP disetujui (sebelum itu `undefined`); `updatePewartaProfile` oleh PIC → 403; bio disanitasi (tag HTML dibuang).
- [ ] **Step 2:** Jalankan tes → FAIL.
- [ ] **Step 3:** Implementasi; tampilan kartu satu kolom di HP, grid di laptop; video disematkan hanya lewat `embedUrl`.
- [ ] **Step 4:** Tes → PASS.
- [ ] **Step 5: Commit** `feat: pewarta list and profile with youtube embed`.

### Task 13: Pendaftaran peserta mandiri dan manual

**Files:**
- Create: `lib/kep/registration.ts`, `lib/security/turnstile.ts`, `lib/security/ratelimit.ts`, `app/(public)/daftar/[token]/page.tsx`, `app/api/daftar/[token]/route.ts`, `app/api/kep/[id]/peserta/route.ts`
- Test: `tests/kep/registration.test.ts`

**Interfaces:**
- Consumes: Task 2, 7, 8 (`sendMail`), 11.
- Produces: `signRegistrationToken(eventId: string): string` dan `verifyRegistrationToken(token: string): { eventId: string } | null` (HMAC-SHA256 dengan `REG_TOKEN_SECRET`); `normalizeWa(raw: string): string | null` (`0812…`, `+62812…`, `62 812-…` → `62812…`); `PesertaInput` (zod): `namaLengkap`, `namaBaptis?`, `jenisKelamin`, `tanggalLahir`, `wa`, `email` (wajib), `alamat`, `parokiAsalId`, `statusPernikahan`, `kontakDarurat`, `pendukungDoa: [{nama; kontak}, {nama; kontak}]` (tepat dua), `riwayatPenyakit?`, `riwayatAlergi?`, `obatRutin?`; `findOrCreatePerson(input: PesertaInput): Promise<{ personId: string; created: boolean }>` (cocokkan lewat WA ternormalisasi atau email huruf kecil; hanya menulis field allowlist); `registerPeserta(eventId: string, input: PesertaInput): Promise<{ status: 'registered' | 'already_registered'; pendaftaranId: string }>` (hanya jika KEP berstatus Disetujui; `Kategori = Peserta`, `StatusPendaftaran = Daftar`; pendaftaran aktif yang sama bukan "Batal" → `already_registered` tanpa baris baru; mengirim email konfirmasi); rate limit publik: 10 pendaftaran per jam per IP.

- [ ] **Step 1: Test gagal:** `normalizeWa('0812-3456-789')`, `('+62 812 3456 789')` sama; orang yang sama dengan WA berformat beda tidak membuat baris TeamUmat baru; pendaftaran kedua orang yang sama → `already_registered` dan jumlah baris Pendaftaran tidak bertambah; KEP berstatus Diajukan → ditolak; token dimodifikasi → `null`; `pendukungDoa` hanya satu → validasi gagal; field di luar allowlist (mis. `jabatanBPK`) di body diabaikan; captcha gagal → 400 dan tidak ada tulisan ke Airtable; IP ke-11 dalam satu jam → 429; email konfirmasi terkirim tepat sekali.
- [ ] **Step 2:** Jalankan tes → FAIL.
- [ ] **Step 3:** Implementasi; form mobile-first satu kolom dengan keyboard yang sesuai (tel, email, tanggal).
- [ ] **Step 4:** Tes → PASS.
- [ ] **Step 5: Commit** `feat: public and manual peserta registration with dedupe`.

### Task 14: Impor Excel (batch) dan template

**Files:**
- Create: `lib/kep/import.ts`, `lib/security/csv.ts`, `app/api/kep/[id]/import/{template,preview,commit}/route.ts`, `app/(app)/kep/[id]/import/page.tsx`
- Test: `tests/kep/import.test.ts`, `tests/kep/fixtures/{valid.xlsx,formula.xlsx,macro.xlsm,empty.xlsx}`

**Interfaces:**
- Consumes: Task 13 (`PesertaInput`, `registerPeserta`).
- Produces: `buildTemplateXlsx(): Promise<Buffer>` (kolom sama dengan `PesertaInput`; contoh satu baris); `neutralize(cell: string): string` (awalan `=`,`+`,`-`,`@` diberi `'`); `parseImport(buf: Buffer): Promise<{ rows: PesertaInput[]; errors: { row: number; message: string }[] }>` (menolak jika bukan xlsx sah, berisi `vbaProject.bin`, lebih dari 2 MB, atau lebih dari 500 baris; baris kosong dilewati); alur dua langkah: `preview` menampilkan baris sah dan galat tanpa menulis apa pun; `commit` hanya menulis baris sah dan mengembalikan ringkasan `{ registered: number; alreadyRegistered: number; failed: number }`.

- [ ] **Step 1: Test gagal:** `neutralize('=HYPERLINK("http://x","y")')` diawali `'`; `.xlsm`/berisi makro → ditolak; 501 baris → ditolak; file valid dengan satu baris cacat → `rows.length` benar dan `errors[0].row` menunjuk baris cacat; `preview` tidak memanggil `createRecords`; `commit` untuk orang yang sudah terdaftar → `alreadyRegistered`.
- [ ] **Step 2:** Jalankan tes → FAIL.
- [ ] **Step 3:** Implementasi dengan `exceljs`; PIC saja.
- [ ] **Step 4:** Tes → PASS.
- [ ] **Step 5: Commit** `feat: excel batch import with template and preview`.

### Task 15: API absensi, mundur, dan penetapan akhir

**Files:**
- Create: `lib/kep/absensi.ts`, `app/api/kep/[id]/absen/[subEventId]/route.ts`, `.../absen/[subEventId]/set/route.ts`, `.../absen/[subEventId]/semua/route.ts`, `app/api/kep/[id]/peserta/[pid]/{mundur,penetapan}/route.ts`
- Test: `tests/kep/absensi.test.ts`

**Interfaces:**
- Consumes: Task 2, 7, 11 (`logAudit`).
- Produces: `getAbsenSheet(actor: Session, eventKepId: string, subEventId: string): Promise<{ subEvent: { id: string; agenda: string; tanggal: string }; peserta: { id: string; nama: string; hadir: boolean; mundur: boolean }[]; hadirCount: number; aktifCount: number }>` (urut abjad; yang mundur diberi `mundur: true` dan tidak dihitung di `aktifCount`); `setHadir(actor: Session, eventKepId: string, subEventId: string, pendaftaranId: string, hadir: boolean, opId: string): Promise<{ hadir: boolean }>` (menetapkan, bukan membalik: `hadir=true` menambah tautan jika belum ada, `hadir=false` mencabutnya; `opId` yang sama dua kali tidak menghasilkan perubahan atau audit ganda; peserta mundur ditolak; tulis dibuat per peserta secara berurutan); `setSemuaHadir(actor, eventKepId, subEventId, opId): Promise<{ updated: number }>` (melewati yang mundur); `mundurkanPeserta(actor, eventKepId, pendaftaranId, opId): Promise<void>` (set Keterangan = MENGUNDURKAN DIRI); `tetapkanHasil(actor, eventKepId, pendaftaranId, hasil: 'LULUS' | 'TIDAK LULUS', opId): Promise<void>` (hanya setelah tanggal SubEvent terakhir; ditolak sebelumnya). Semua peran `PIC` dan `ADMIN` untuk parokinya; setiap perubahan memanggil `logAudit`.

- [ ] **Step 1: Test gagal:** `setHadir(..., true)` dua kali dengan `opId` sama → tautan tepat satu, audit tepat satu; dengan `opId` berbeda → tautan tetap satu (idempoten secara nilai); `setHadir(..., false)` mencabut hanya SubEvent itu dan menyisakan tautan lain; peserta mundur → ditolak; ADMIN paroki A mengabsen KEP paroki B → 404; `setSemuaHadir` melewati peserta mundur; `tetapkanHasil` sebelum pertemuan terakhir → ditolak; setelah itu berhasil dan mengubah Keterangan; SEP memanggil `setHadir` → 403.
- [ ] **Step 2:** Jalankan tes → FAIL.
- [ ] **Step 3:** Implementasi: baca tautan terkini peserta, hitung himpunan baru, tulis; antrean berurutan per `pendaftaranId` dalam satu proses.
- [ ] **Step 4:** Tes → PASS.
- [ ] **Step 5: Commit** `feat: attendance api with link-based presence and audit`.

### Task 16: UI Absen (cepat, satu tangan) dan PWA

**Files:**
- Create: `app/(app)/kep/[id]/absen/page.tsx`, `app/(app)/kep/[id]/absen/_components/{PesertaRow,HeaderCount,UndoToast,TambahPeserta}.tsx`, `lib/offline/queue.ts`, `public/manifest.webmanifest`, `app/(app)/kep/[id]/penetapan/page.tsx`
- Test: `tests/offline/queue.test.ts`, `e2e/absen.spec.ts`

**Interfaces:**
- Consumes: Task 15 endpoint.
- Produces: `enqueue(op: { opId: string; url: string; body: object }): Promise<void>`, `flush(send: (op) => Promise<boolean>): Promise<{ sent: number; pending: number }>` (urut, berhenti di kegagalan jaringan, mempertahankan antrean di IndexedDB lewat `idb-keyval`).

- [ ] **Step 1: Test gagal:** unit: `flush` mengirim urut dan berhenti saat `send` mengembalikan `false` dengan sisa tetap di antrean; e2e (viewport 390×844): halaman Absen membuka pertemuan hari ini otomatis; setiap baris peserta `boundingBox().height >= 56`; ketuk satu baris langsung menampilkan centang (< 100 ms, sebelum respons server) dan header berubah "1 dari N hadir"; ketuk lagi membatalkan; pesan "Batalkan" muncul setelah perubahan; mode offline (`context.setOffline(true)`) menampung tiga ketukan, lalu `setOffline(false)` mengirim ketiganya sekali tiap `opId`; tombol "Tandai semua hadir" meminta konfirmasi; menu "⋯" → "Mengundurkan diri" menandai baris redup; pencarian memfilter daftar; tidak ada tombol "Simpan".
- [ ] **Step 2:** Jalankan tes → FAIL.
- [ ] **Step 3:** Implementasi UI dengan pembaruan optimistis dan indikator "tersimpan"/"menunggu sinyal"; di laptop tombol Spasi menandai baris terfokus; `manifest.webmanifest` agar bisa dipasang di layar utama.
- [ ] **Step 4:** `pnpm test tests/offline` dan `pnpm e2e e2e/absen.spec.ts` → PASS.
- [ ] **Step 5: Commit** `feat: fast mobile attendance ui with offline queue`.

### Task 17: Dashboard dan laporan

**Files:**
- Create: `lib/kep/reports.ts`, `app/(app)/dashboard/page.tsx`, `app/(app)/dashboard/sep/page.tsx`, `app/api/laporan/[jenis]/route.ts`
- Test: `tests/kep/reports.test.ts`

**Interfaces:**
- Consumes: Task 9 (`listKepEvents`), Task 7 (`scopeFilter`).
- Produces: `rekapAngkatan(scope): Promise<{ paroki: string; angkatan: number; peserta: number; lulus: number; tidakLulus: number; mundur: number }[]>`; `kehadiranPerPertemuan(actor: Session, eventKepId: string): Promise<{ agenda: string; tanggal: string; hadir: number; aktif: number }[]>`; `trenTahunan(scope): Promise<{ tahun: number; angkatan: number; peserta: number; lulus: number }[]>`; `profilPeserta(scope): Promise<{ kelompokUsia: Record<string, number>; jenisKelamin: Record<string, number>; statusPernikahan: Record<string, number> }>` (agregat tanpa nama); `toCsv(rows: Record<string, unknown>[]): string` (memakai `neutralize` Task 14). Dashboard SEP memuat peta/daftar sebaran paroki, tren, antrean persetujuan, profil peserta; dashboard paroki hanya data paroki itu. Gunakan skill `dataviz` untuk grafik.

- [ ] **Step 1: Test gagal:** scope paroki A tidak memuat baris paroki B; `rekapAngkatan` menghitung lulus dari Keterangan (bukan status kehadiran) dan tidak menghitung mundur sebagai lulus; data legacy dengan paroki "Belum terpetakan" tidak membuat error; `kehadiranPerPertemuan` tidak menghitung peserta yang mundur sebelum pertemuan itu sebagai `aktif`; `toCsv` menetralkan sel `=…`.
- [ ] **Step 2:** Jalankan tes → FAIL.
- [ ] **Step 3:** Implementasi dan halaman (kartu angka di HP, tabel di laptop).
- [ ] **Step 4:** Tes → PASS.
- [ ] **Step 5: Commit** `feat: dashboards and reports`.

### Task 18: Pemetaan data lama (GERBANG PERSETUJUAN)

**Files:**
- Create: `scripts/map-legacy.ts`, `tests/scripts/map-legacy.test.ts`, `tests/scripts/fixtures/*.json`

**Interfaces:**
- Consumes: Task 2, 3.
- Produces: perintah `pnpm map-legacy` (default `--dry-run`) menghasilkan `reports/legacy-mapping.csv` (cocok, tidak cocok, duplikat, rencana tulis); `pnpm map-legacy --apply --confirm=YA` menjalankan tiga hal tanpa menghapus apa pun: (a) menyalin BabKEP ke SubEvent (agenda = nilai Bab, tanggal, pengajar, tertaut ke Events lewat EventKEP.Events), (b) mengisi `EventKEP.Events` dengan mencocokkan paroki+angkatan, (c) mengisi `Pengelenggara KEP.Paroki` dengan mencocokkan nama ke tabel Paroki.

- [ ] **Step 1: Test gagal:** dry-run tidak memanggil `createRecords`/`updateRecords`; duplikat (Laurentius Angkatan 18 ×2) dilaporkan, tidak digabung atau dihapus; paroki tak cocok → baris "tidak cocok", tidak ditulis; `--apply` tanpa `--confirm=YA` keluar dengan kode ≠ 0; kedua kali `--apply` tidak membuat SubEvent ganda (idempoten, kunci = ID BabKEP asal).
- [ ] **Step 2:** Jalankan tes → FAIL.
- [ ] **Step 3:** Implementasi; simpan ID BabKEP asal di SubEvent.Keterangan sebagai kunci idempotensi.
- [ ] **Step 4:** Tes → PASS. Jalankan **dry-run** pada data sebenarnya, kirim `legacy-mapping.csv` kepada pengguna, dan **tunggu persetujuan eksplisit** sebelum `--apply`. Setelah apply: laporkan jumlah baris SubEvent yang dibuat dan field yang diisi, dan kirim ringkasan ke timmy.theopelus@gmail.com (data baru, bukan tabel/field baru, tetapi dilaporkan demi jejak).
- [ ] **Step 5: Commit** `feat: legacy data mapping script (dry-run default)`.

### Task 19: Pengerasan keamanan, deploy, dan verifikasi akhir

**Files:**
- Create: `tests/security/{csrf,authz-matrix,pii-leak}.test.ts`, `docs/ops/runbook.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: semua tugas sebelumnya.

- [ ] **Step 1: Test gagal:** `authz-matrix.test.ts` memanggil setiap route API dengan setiap peran (SEP, PIC, ADMIN, tanpa sesi) dan membandingkan dengan matriks hak akses spec bagian 6 (satu sumber kebenaran di `tests/security/matrix.ts`); `csrf.test.ts`: permintaan `POST` dari origin lain ditolak; `pii-leak.test.ts`: tidak ada respons API publik atau halaman publik yang memuat NoHP, email, atau field di luar allowlist.
- [ ] **Step 2:** Jalankan `pnpm test tests/security` → perbaiki sampai PASS.
- [ ] **Step 3:** Tulis `docs/ops/runbook.md`: membuat token Airtable berizin minimal (hanya `data.records:read`/`data.records:write`, hanya base BPK Bandung), rotasi token tiap 90 hari, variabel Vercel, daftar langkah mencabut akses, pencarian rahasia di riwayat git.
- [ ] **Step 4:** Deploy ke Vercel (preview), jalankan `pnpm test && pnpm e2e && pnpm lint && pnpm audit` dan uji manual di HP nyata: login, absen satu pertemuan, daftar peserta lewat link. Gunakan skill `verification-before-completion` sebelum menyatakan selesai.
- [ ] **Step 5: Commit** `chore: security hardening, runbook, deploy`.

---

## Self-Review

**Spec coverage:** tujuan dan peran (Task 5–8, 11); aturan Airtable dan laporan/email (Task 3, 18); arsitektur dan keamanan (Task 1, 2, 4–7, 13, 14, 19); model data baru (Task 3); data lama (Task 9, 18); persetujuan SEP (Task 11); jadwal tetap (Task 11); pewarta dan YouTube (Task 12); pendaftaran mandiri, manual, Excel, email konfirmasi (Task 13, 14); absensi, mundur, lulus (Task 15, 16); landing dan kesaksian (Task 10); dashboard dan laporan (Task 17); sub-event umum (Task 3, 11, 18). Tidak ada bagian spec tanpa tugas.

**Keputusan rencana yang melebihi spec (perlu ditinjau):** kunci 5 gagal login → 15 menit; undangan akun berlaku 72 jam; rate limit 10 pendaftaran per jam per IP; urutan template 28 pertemuan (posisi Evaluasi Kunjungan rumah sebelum Retreat); Google tetap mewajibkan TOTP untuk SEP dan PIC; sesi 15 menit geser hingga 8 jam; batas Excel 2 MB dan 500 baris.

**Konsistensi tipe:** `Session`/`Role` (Task 5) dipakai Task 7–17; `PesertaInput` (Task 13) dipakai Task 14; `logAudit` (Task 11) dipakai Task 15; `neutralize` (Task 14) dipakai Task 17; `scopeFilter` (Task 7) dipakai Task 9 dan 17.
