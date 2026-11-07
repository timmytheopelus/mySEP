# Aplikasi KEP Keuskupan Bandung — Spesifikasi Desain

Tanggal: 2026-11-06 (revisi 2: memakai struktur Airtable yang sudah ada)
Status: DRAFT, menunggu review pengguna. Belum ada tabel/field Airtable yang dibuat dan belum ada kode yang ditulis.

## 1. Tujuan dan pengguna

Memantau pendataan dan pelaksanaan KEP (Kursus Evangelisasi Pribadi) di seluruh Keuskupan Bandung: paroki mana yang sudah menjalankan, berapa angkatan, tren, dan profil peserta.

Pengguna:
- **PIC KEP Paroki**: membuat KEP, mengajukan pewarta, mengelola peserta.
- **Admin Paroki**: absensi peserta dan status akhir.
- **SEP BPK Bandung (Bu Liani dan tim)**: menyetujui pengajuan, memantau se-keuskupan, mengelola akun.
- **Peserta**: mendaftar sendiri lewat link (lebih sering dari HP).
- **Publik**: membaca landing page.

Kriteria sukses: SEP dapat melihat sebaran paroki, jumlah angkatan, tren, dan profil peserta; paroki dapat menjalankan KEP dari pembuatan sampai kelulusan tanpa spreadsheet manual; **data KEP lama tetap terpakai**.

## 2. Aturan operasional Airtable (wajib)

- Dilarang menghapus tabel yang sudah ada. Jika ada permintaan yang berpotensi menghapus tabel, beri peringatan dan hentikan.
- Setiap pembuatan tabel baru atau field baru wajib dilaporkan kepada pengguna dan dikirim lewat email ke timmy.theopelus@gmail.com.
- Prinsip: **pakai struktur yang sudah ada, tambah seminimal mungkin**. Tidak ada field baru yang tidak diperlukan.
- Aplikasi tidak memiliki kode penghapusan data. Penghapusan peserta memakai soft-delete atau status Batal.
- Base yang dipakai: **BPK Bandung** (`appIGR8Duhj3Vsz48`).

## 3. Arsitektur

- Web app **Next.js**, mobile-first (HP utama), layout melebar untuk laptop dari kode yang sama.
- Kode di GitHub pengguna, deploy otomatis ke **Vercel**.
- Server API menyimpan token Airtable (hanya di environment variable), memeriksa login dan peran, dan memfilter data per paroki.
- Email konfirmasi lewat layanan email (mis. Resend).
- Airtable tetap satu-satunya database.

## 4. Keamanan

Login:
- Email+password (hash Argon2id, minimal 12 karakter, cek password bocor) dan Google SSO (OpenID Connect).
- Hanya email yang sudah dibuat SEP di tabel AkunKEP yang boleh masuk; email Google harus terverifikasi.
- Akun dibuat oleh SEP; tidak ada pendaftaran akun publik.
- MFA (TOTP) wajib untuk SEP dan PIC Paroki; opsional untuk Admin Paroki.
- Pembatasan percobaan login, penguncian sementara, pesan error seragam, reset password dengan link sekali pakai (30 menit).

Aplikasi:
- Cookie HttpOnly, Secure, SameSite; sesi pendek dan bisa dicabut.
- Proteksi CSRF, header keamanan (CSP ketat, HSTS), validasi input di server.
- Otorisasi di server pada setiap query (data dibatasi ke paroki akun, kecuali SEP).
- **Allowlist field**: tabel MasterData TeamUmat juga memuat data kepengurusan BPK dan data pribadi lain. Server hanya boleh membaca dan menulis field yang ada di daftar putih (data diri peserta); field lain tidak pernah dikirim ke browser.

Form publik dan unggah:
- Captcha (Cloudflare Turnstile), rate limit per IP.
- Link pendaftaran per KEP memakai **token bertanda tangan** yang dihitung server dari ID acara (tidak perlu field baru, tidak bisa ditebak, bisa dicabut dengan mengganti kunci).
- Unggah Excel: hanya .xlsx, batas ukuran, tanpa makro, netralisasi sel berawalan `=`, `+`, `-`, `@`.

Data dan rahasia:
- Token Airtable berizin minimal (baca/tulis data; tanpa ubah skema, tanpa hapus), hanya di server, dirotasi berkala.
- Karena aplikasi memakai base BPK Bandung, token punya akses ke seluruh base (keterbatasan Airtable: scope per base, bukan per tabel). Risiko ini diterima pengguna; mitigasi seperti di atas.
- Pemindaian rahasia dan dependensi di GitHub (Dependabot).
- Jejak audit untuk absensi, kelulusan, persetujuan, dan perubahan status.
- Data kesehatan (riwayat penyakit, alergi, obat) bersifat sensitif: hanya diminta jika memang dibutuhkan untuk retret, bersifat opsional, dan hanya terlihat oleh PIC dan Admin paroki yang bersangkutan.

## 5. Model data: memakai yang sudah ada

Hasil pembacaan base BPK Bandung (hanya baca): data KEP terbagi dua sisi yang belum terhubung.

**Sisi jadwal dan pewarta**
- **Pengelenggara KEP** (9 paroki), **EventKEP** (13 baris: penyelenggara, angkatan, tanggal mulai/selesai, jenis KEP/SEP, jadwal), **BabKEP** (299 baris: tanggal, bab, pengajar), **Data Pengajar KEP** (nama, foto, status, jumlah mengajar per bab).
- Pilihan "Bab" di BabKEP **sudah lengkap**: Misa Pembukaan, Bab 1 sampai 10, Evangelii Nuntiandi, Iman Katolik, Maria Bintang Evangelisasi, Pengantar Retus, Retreat Pengutusan, Peneguhan, dan Evaluasi Kunjungan rumah. Tidak perlu menambah pilihan.
- Penugasan pewarta per bab **sudah ada** (BabKEP terhubung ke Data Pengajar KEP).

**Sisi peserta**
- **Events**: acara KEP memakai Kelompok Acara = "KEP", nama berpola "KEP PAROKI ... ANGKATAN n", lokasi, tanggal, dan jumlah pendaftar.
- **Pendaftaran Events**: satu baris per peserta per acara. Sudah ada: link ke Events, link ke orangnya (MasterData TeamUmat), Status Pendaftaran (Daftar / Confirmed / Paid & Confirm / Batal / Dobel Daftar), Kategori Kepesertaan (Peserta / Panitia), **Keterangan (LULUS / TIDAK LULUS / MENGUNDURKAN DIRI)**, Sertifikat KEP, Kelompok Usia, Status Pernikahan, riwayat penyakit, alergi, obat, dan kontak darurat.
- **MasterData TeamUmat**: data induk orang (nama lengkap, nama baptis, email, WA, tanggal lahir dan umur, alamat, jenis kelamin, status pernikahan, paroki, PD/komunitas). Peserta KEP memakai tabel ini; satu orang satu baris sehingga riwayat tidak terduplikasi.
- **KehadiranEvent**: catatan kehadiran (status "Hadir") per acara, terhubung ke Pendaftaran Events. Tidak dipakai untuk absensi KEP (alasan: 1.600 baris per angkatan; lihat model absensi di bawah).

**Pemetaan kebutuhan aplikasi ke tabel yang sudah ada**

| Kebutuhan | Dipakai |
|---|---|
| Daftar paroki dan angkatan | Pengelenggara KEP, EventKEP (angkatan), Events |
| Peserta KEP | Pendaftaran Events (+ MasterData TeamUmat untuk data diri) |
| Lulus, tidak lulus, mundur | Pendaftaran Events › Keterangan |
| Mundur di tengah jalan | Keterangan = MENGUNDURKAN DIRI; bab terakhir diikuti dihitung dari catatan kehadiran |
| Profil peserta (usia, jenis kelamin, status nikah, paroki) | MasterData TeamUmat + Pendaftaran Events |
| Sertifikat | Pendaftaran Events › Sertifikat KEP |
| Pewarta per pertemuan | SubEvent › Pengajar (jadwal lama di BabKEP disalin sekali dengan persetujuan; BabKEP tidak dihapus) |
| Foto pewarta, status | Data Pengajar KEP |
| Hadir per pertemuan | Pendaftaran Events › Pertemuan Hadir (tautan ke SubEvent; tidak tertaut = tidak hadir) |

### Tambahan minimal (belum dibuat; dilaporkan dan diemail ke Timmy saat dieksekusi)

**3 tabel baru**
- **AkunKEP**: email, nama, peran (SEP / PIC Paroki / Admin Paroki), paroki (link ke tabel Paroki), hash password, ID Google, rahasia MFA (terenkripsi), status aktif, login terakhir, jumlah gagal login, waktu kunci. Alasan: tidak ada tabel akun aplikasi; UserSMP dipakai untuk keperluan lain.
- **SubEvent** (diputuskan: dikerjakan sekarang, umum untuk semua acara BPK): acara (link ke Events), nama agenda, urutan, tanggal, jam mulai, jam selesai, pengajar (link ke Data Pengajar KEP, opsional), keterangan. Satu baris per pertemuan/agenda. KEP memakainya untuk 28 pertemuan tetap (dikonfirmasi pemilik 2026-11-07); acara BPK lain bisa memakainya untuk agenda majemuk tanpa mengubah alur lama.
- **AuditKEP** (disepakati bersama model absensi): siapa, kapan, aksi, peserta dan pertemuan terkait, sebelum/sesudah. Menyimpan jejak absensi, kelulusan, mundur, dan persetujuan.

**8 field baru pada tabel yang sudah ada**

| # | Tabel | Field | Alasan |
|---|---|---|---|
| 1 | EventKEP | Status Persetujuan (Diajukan / Disetujui / Ditolak) | Alur persetujuan SEP |
| 2 | EventKEP | Catatan SEP (teks panjang) | Alasan setuju atau tolak |
| 3 | EventKEP | Events (link ke tabel Events) | Menghubungkan sisi jadwal dengan sisi peserta |
| 4 | Pengelenggara KEP | Paroki (link ke tabel Paroki) | Dasar pembatasan akses per paroki |
| 5 | Pendaftaran Events | Pertemuan Hadir (link ke SubEvent, boleh banyak) | Absensi per pertemuan: satu baris peserta, kehadiran berupa tautan |
| 6 | Pendaftaran Events | Pendukung Doa (teks panjang, dua nama dan kontak) | Syarat peserta menurut buku KEP |
| 7 | Data Pengajar KEP | Link YouTube (URL) | Profil pewarta |
| 8 | Data Pengajar KEP | Bio Singkat (teks panjang) | Profil pewarta |

### Model absensi (diputuskan)
Satu baris per peserta di Pendaftaran Events; kehadiran = tautan di kolom "Pertemuan Hadir" ke baris SubEvent. Mengabsen berarti menambah tautan, membatalkan berarti mencabutnya. Tidak ada baris baru per absen (60 baris per angkatan, bukan sekitar 1.600). Jam dan pencatat tiap perubahan disimpan di AuditKEP. Kehadiran per peserta, per pertemuan, dan bab terakhir yang diikuti dihitung dari tautan itu.

Yang **tidak** ditambah: tanggal mundur, alasan mundur, sumber daftar, status email terkirim, hash token, pekerjaan, pendidikan, disetujui oleh, dan tanggal persetujuan. Semuanya dapat dihitung dari data yang ada atau dicatat di audit.

**Kunjungan rumah (diputuskan)**: dicatat sebagai pertemuan tambahan "Evaluasi Kunjungan rumah" di BabKEP dan diabsen lewat KehadiranEvent seperti pertemuan lain. Tidak ada field baru.

### Jadwal KEP tetap (template pertemuan)
- Jumlah dan urutan pertemuan KEP **tetap**, mengikuti contoh jadwal di buku (Misa Pembukaan, Bab 1, Bab 2 sampai Evangelii Nuntiandi dan Bab 3 sampai Bab 9 masing-masing 2 pertemuan, Bab 10 dan dua bab pilihan, Retret Pengutusan) ditambah Evaluasi Kunjungan rumah.
- Saat PIC membuat KEP dan mengisi tanggal mulai, aplikasi **membuat otomatis semua baris SubEvent** (pertemuan) dari template dengan tanggal mingguan; PIC hanya menyesuaikan tanggal bila perlu. PIC tidak menambah atau menghapus pertemuan.
- Template ada di kode aplikasi (bukan di Airtable), sehingga tidak ada tabel atau field baru. Detail urutan dan jumlah final dikonfirmasi saat penyusunan rencana implementasi.

### Catatan kualitas data lama (perlu dirapikan sebelum dipakai di dashboard)
- Ada acara KEP ganda: "St. Laurentius Angkatan 18" dan "Paroki Pandu Angkatan 9" masing-masing muncul dua kali di Events.
- Angkatan hanya tertulis di nama acara (Events); angka angkatan terstruktur ada di EventKEP. Setelah field #3 terisi, angka itu bisa dipakai.
- Tidak semua paroki di Events ada di Pengelenggara KEP (mis. Paulus, Katedral). Perlu pemetaan satu kali sebelum paroki bisa difilter.
- Events dengan Kelompok Acara = "KEP" juga memuat acara non-kursus (Pembekalan Pengajar KEP, Bina Lanjut KEP). Dashboard harus membedakan kursus dan non-kursus (mis. lewat nama atau hubungan ke EventKEP).
- Beberapa acara punya peserta berstatus "Daftar" dengan Keterangan LULUS dan kehadiran "Belum Hadir" (data lama hasil impor). Perhitungan kelulusan memakai Keterangan, bukan status kehadiran.
- Pemetaan satu kali ini dilakukan dengan persetujuan Anda, bukan otomatis.

## 6. Peran dan hak akses

| Peran | Bisa | Tidak bisa |
|---|---|---|
| Admin Paroki | Absensi per bab, tandai mundur, lulus/tidak, kunjungan rumah, lihat data dan riwayat paroki sendiri | Membuat KEP, mengajukan pewarta, lihat paroki lain |
| PIC Paroki | Hak Admin + buat KEP (tgl mulai-selesai), ajukan pewarta, kelola peserta (manual, Excel, link), laporan paroki, lihat no. HP pewarta yang sudah disetujui untuk KEP-nya | Menyetujui pengajuan, lihat paroki lain |
| SEP | Setujui/tolak KEP dan pewarta (dengan catatan), lihat seluruh keuskupan, kelola akun, unduh laporan, ubah bio/link YouTube pewarta | Mengubah absensi (hanya koreksi tercatat di audit) |

Mundur di tengah jalan: Admin menandai Keterangan = MENGUNDURKAN DIRI; bab berikutnya tidak lagi menuntut absensi; catatan kehadiran sebelumnya tetap. Koreksi oleh PIC atau SEP, tercatat di audit.

## 7. Alur utama

1. SEP membuat akun PIC dan Admin paroki (undangan atau password awal lewat email).
2. PIC membuat KEP (tanggal, angkatan) dan memilih pewarta per bab dari profil; status "Diajukan". Aplikasi membuat baris di EventKEP dan Events, menghubungkannya, dan membuat semua baris SubEvent (pertemuan) dari template.
3. SEP menyetujui atau menolak (dengan catatan); PIC diberi tahu lewat email.
4. Setelah disetujui, peserta masuk lewat: daftar mandiri via link KEP (email konfirmasi otomatis), input manual, atau unggah batch Excel (template disediakan). Aplikasi mencari orangnya di MasterData TeamUmat (cocokkan WA atau email) agar tidak terduplikasi, lalu membuat baris Pendaftaran Events.
5. Admin mengabsen per pertemuan (menambah tautan di Pertemuan Hadir), menandai mundur bila perlu.
6. Di akhir, Admin menetapkan LULUS atau TIDAK LULUS (dan kunjungan rumah, lihat bagian 11).
7. SEP memantau di dashboard dan laporan.

## 8. Halaman

1. **Landing publik**: lihat 10b.
2. **Form pendaftaran peserta** (link per KEP): data pribadi lengkap (nama lengkap, nama baptis, jenis kelamin, tanggal lahir, WA, email, alamat, paroki asal, status pernikahan, kontak darurat, dua pendukung doa; data kesehatan opsional), tanpa data kepengurusan BPK; captcha; email konfirmasi.
3. **Login**: email+password atau Google, plus MFA.
4. **Dashboard paroki**: KEP aktif, angkatan, jumlah peserta, riwayat, laporan.
5. **Detail KEP**: daftar peserta, jadwal pertemuan, tombol masuk ke layar Absen (lihat 8b), unggah Excel, bagikan link pendaftaran.
6. **Daftar pewarta**: kartu dengan foto, nama, bab yang bisa diajar, pengalaman; pencarian dan filter bab.
7. **Profil pewarta**: foto, bio, bab dikuasai, riwayat KEP, video YouTube (embed resmi, hanya URL YouTube valid), tombol Ajukan untuk PIC. Hanya pewarta berstatus Aktif yang muncul; no. HP hanya terlihat PIC setelah pewarta disetujui untuk KEP-nya. Halaman hanya setelah login.
8. **Dashboard SEP**: sebaran paroki, tren angkatan dan kelulusan, antrean persetujuan, profil peserta (kelompok usia, jenis kelamin, status pernikahan), kelola akun.

## 8b. UI/UX absensi (prioritas: mudah, sederhana, cepat; HP satu tangan)

Tujuan: mengabsen 60 peserta dalam hitungan menit di HP, tanpa pelatihan.

1. **Langsung ke pertemuan hari ini.** Setelah login, Admin melihat satu kartu besar "Absen: Bab 2 (bagian 1), hari ini" dengan satu tombol. Pertemuan dipilih otomatis dari tanggal; pertemuan lain bisa dipilih dari daftar geser.
2. **Satu ketukan = hadir.** Daftar peserta berbaris besar (tinggi minimal 56 px), urut abjad. Ketuk baris untuk hadir (centang hijau); ketuk lagi untuk membatalkan. Tidak ada tombol "Simpan".
3. **Tersimpan otomatis.** Tiap ketukan langsung terlihat berubah (tanpa menunggu server) dan disimpan di latar belakang. Indikator kecil menunjukkan "tersimpan". Jika sinyal buruk, ketukan diantre di HP dan dikirim ulang saat tersambung; kegagalan diberi tanda yang jelas.
4. **Cepat untuk kelas penuh.** Tombol "Tandai semua hadir" (dengan konfirmasi), lalu Admin hanya mencabut yang tidak hadir. Pencarian nama di atas daftar; di laptop, ketik nama lalu tekan Spasi untuk menandai.
5. **Hitungan selalu terlihat.** Header menempel menampilkan "42 dari 58 hadir". Peserta yang sudah mundur tidak dihitung.
6. **Batalkan salah ketuk.** Setiap perubahan menampilkan pesan "Batalkan" selama beberapa detik.
7. **Mundur di tengah jalan.** Menu "⋯" pada baris peserta, pilih "Mengundurkan diri", konfirmasi. Peserta tampil redup dan tidak muncul di pertemuan berikutnya. Data hadir sebelumnya tetap.
8. **Peserta datang langsung.** Tombol "+ Tambah peserta": isi nama dan WA, peserta terdaftar dan langsung bisa diabsen; PIC melengkapi datanya kemudian.
9. **Penetapan akhir (lulus atau tidak).** Layar terpisah di akhir kursus: daftar peserta dengan persentase kehadiran, ketuk untuk LULUS atau TIDAK LULUS. Hanya aktif setelah pertemuan terakhir.
10. **Bukan hanya cepat, tetapi juga aman.** Admin hanya melihat peserta parokinya. Setiap perubahan tercatat di AuditKEP.
11. **Kinerja.** Layar Absen hanya memuat satu pertemuan dan daftar peserta satu KEP; target tampil di bawah 1 detik di jaringan seluler; tulisan besar dan kontras tinggi; berfungsi sebagai aplikasi web yang bisa dipasang di layar utama HP.

## 9. Pengujian

- Uji otorisasi per peran dan lintas paroki (akses ke paroki lain harus ditolak di server).
- Uji login (rate limit, MFA, Google dengan email tak terdaftar ditolak).
- Uji allowlist field (field kepengurusan BPK tidak pernah muncul di respons).
- Uji unggah Excel (file berbahaya, formula injection, ukuran besar).
- Uji form publik (captcha, rate limit, email konfirmasi, pendaftar ganda tidak membuat orang ganda).
- Uji data lama (acara ganda, paroki tanpa pemetaan) tidak merusak dashboard.
- Uji absensi: ketuk hadir dan batalkan, tersimpan otomatis, antrean saat offline lalu sinkron, dua Admin mengabsen bersamaan tidak saling menimpa, peserta mundur tidak muncul di pertemuan berikutnya, setiap perubahan tercatat di AuditKEP.
- Uji tampilan di HP dan laptop.

## 10. Di luar cakupan awal (YAGNI)

- Pendaftaran akun publik, pembayaran, notifikasi WhatsApp otomatis, aplikasi native.

## 10b. Isi landing page (bersumber dari buku "Kerangka Acuan Program KEP", BPK Bandung, Juni 2023)

KEP = Kursus Evangelisasi Pribadi. Bagian landing page:
1. **Apa itu KEP**: kursus untuk membantu umat menyadari panggilan dan perutusan mewartakan Injil, dimulai dari diri sendiri lalu kepada sesama secara pribadi; program pembinaan dan pelatihan dengan metode efektif, sistematis, dan sederhana.
2. **Tujuan**: (a) sarana mengalami pertobatan dan kehadiran Tuhan lebih nyata; (b) memperlengkapi peserta mewartakan Injil lewat perilaku nyata dan keterlibatan dalam keluarga, gereja, dan masyarakat.
3. **Untuk siapa**: semua umat segala usia, khususnya yang sudah dibaptis Katolik atau sedang katekumen. KEP bukan pengganti proses katekumen.
4. **Cara mengikuti**: mengisi formulir dan menyelesaikan syarat administrasi; setiap peserta memiliki dua pendukung doa selama kursus.
5. **Materi dan metode**: 11 bab wajib (Bab 1 sampai 10 dan Evangelii Nuntiandi) dan 2 bab pilihan (Maria Bintang Evangelisasi, Iman Katolik); tiap bab dianjurkan 2 pertemuan @3 jam (kecuali Bab 1 dan bab pilihan); praktik berupa sharing kelompok, latihan, tugas kelompok, roleplay, dan kunjungan rumah berdua-dua di akhir kursus; ditutup Retret Pengutusan (minimal 2 hari 1 malam).
6. **Buku pegangan**: Kitab Suci, Buku Misi Evangelisasi Baru, dan Evangelii Nuntiandi.
7. **Buah KEP**: kesadaran dan komitmen berkarya di gereja dan masyarakat, perubahan hidup, kepedulian pada sesama, relasi yang dipulihkan.
8. **FAQ**: KEP bukan program PDPKK melainkan program paroki untuk seluruh Gereja; pengajar harus lulus Trainer's Course (saat ini diselenggarakan PDPKK); peserta tidak harus aktif di PDPKK.
9. **Kesaksian alumni**: nama dan foto hanya ditampilkan untuk alumni yang sudah memberi izin; selebihnya hanya kutipan tanpa nama dan foto. SEP dapat menambah izin kemudian.
10. **Latar belakang** (opsional, ringkas): dorongan pewartaan Injil pasca Konsili Vatikan II dan Evangelii Nuntiandi.
11. **Sebaran paroki dan angka ringkas**: dari data Airtable (bukan dari buku).

## 11. Pertanyaan terbuka

1. **Sub-event umum**: diputuskan dikerjakan sekarang bersama KEP (lihat bagian 12). Perlu konfirmasi pemetaan jadwal lama BabKEP ke SubEvent.
2. Daftar jenis laporan yang dibutuhkan paroki dan SEP (usulan awal: rekap angkatan, daftar kelulusan, kehadiran per bab, tren tahunan).
3. Persetujuan pemetaan data lama satu kali (acara ganda, paroki yang belum terhubung) sebelum dashboard dipakai.
4. Perlu tidaknya tabel AuditKEP (disarankan).

## 12. Sub-event umum untuk acara BPK (diputuskan: sekarang)

Keputusan pengguna: tabel SubEvent dibuat sekarang dan dipakai KEP. Catatan pertimbangan di bawah tetap berlaku sebagai mitigasi risiko: tabel Events tidak diubah strukturnya; SubEvent hanya ditautkan ke Events, sehingga alur lain (pendaftaran, WA, QR, tiket, rapat) tidak terpengaruh. BabKEP tidak dihapus; isinya disalin ke SubEvent sekali dengan persetujuan.

Pertimbangan awal:

Pola yang dipakai KEP sudah merupakan sub-event: satu acara (EventKEP/Events) memiliki banyak pertemuan (BabKEP), dan kehadiran dicatat per pertemuan (KehadiranEvent › BabKEP). Untuk acara BPK lain yang punya banyak agenda, polanya bisa diumumkan menjadi satu tabel **SubEvent** (acara, nama agenda, tanggal, jam) yang dihubungkan ke Events dan KehadiranEvent.

Pertimbangan:
- Tabel Events dipakai banyak alur lain (pendaftaran, WA, QR hari-H, tiket, rapat panitia). Mengubahnya berisiko mengganggu alur yang berjalan.
- Pendekatan aman: tahap 1 selesai untuk KEP dengan BabKEP; tahap 2 menambah SubEvent umum dan menguji pada satu acara non-KEP, tanpa mengubah alur lama. KEP dapat dimigrasi ke SubEvent belakangan bila diinginkan.
- Pilihan lain: membuat SubEvent umum sekarang dan langsung dipakai KEP (BabKEP ikut dimigrasi). Lebih rapi, tetapi lebih besar cakupannya dan menunda aplikasi KEP.
