# Perubahan Airtable (base BPK Bandung appIGR8Duhj3Vsz48) — 2026-11-06

Tidak ada tabel/field lama yang dihapus atau diubah.

## Tabel baru (3)
- SubEvent `tblZ3zq2vB37Dxqfp`: Agenda fld6n7fszdA2YmmzM, Acara fldG03oIWIqrUgGLX, Urutan fldaZPMpQnLjHh5wZ, Tanggal fldUjbwLw0J6tMF0h, Jam Mulai fld5KQvsCHytRZKGQ, Jam Selesai fldSUdoLGXbHVAhCe, Pengajar fldM6XcvHnkLk8Pf1, Keterangan fldLdr0T6XHgqLwl2
- AkunKEP `tbleebgqGzUZPzwes`: Email fldhSj7cXUhRxXJOu, Nama fldUx3sdEOcE8Qgfe, Peran fld59EjsnXN54H9xj, Paroki fldZFNJGpXd4szQ0O, Hash Password fldtaOmwb0FCSdCOE, ID Google fldNR0aLOKTCFod2x, Rahasia MFA fldIykU3vFQ3OZdqH, Status Aktif fldySiZtvggiAC3u2, Login Terakhir fldECGrMWK81V0YtY, Gagal Login fldSzGn8Ul8HU99yi, Waktu Kunci fldDdLKILJPHSbnut
- AuditKEP `tblyZWZEDw8woCjQ7`: Aksi fldVn2L5B4eSjzmex, Pelaku fld5xTtJt7R1TG0Z5, Target ID fldir7qLRAnIb14Qj, Sebelum fld6BBZ4CpW8NQZrJ, Sesudah fldHhmDBjZSGLtAoI, Op ID fldMdPPqsFVvspYMF

## Field baru di tabel lama (8)
- EventKEP tbllEWCLGPMwXnVBT: Status Persetujuan fldVi4F0TJit1MbmI, Catatan SEP fldhr8M2mdO1wHVPe, Events fldyZwU5mLOjjatLs
- Pengelenggara KEP tblH4SN6qpNxJFg35: Paroki fld2sPNpixsNArdjf
- Pendaftaran Events tbltiJ1qDJEwfWPLg: Pertemuan Hadir fld2ylVkRD9BpFLyH, Pendukung Doa fldeGUtCP76Kpzcwo
- Data Pengajar KEP tblphUIZPACl1BKpS: Link YouTube fld8hjcXk5yxWO31p, Bio Singkat fldVMLPJuzL8673mZ

## Field kebalikan otomatis (dibuat Airtable karena field link)
- Events (tblbAIILkeRIwn3kl): fldvytyB1Pyrt0qKB (dari SubEvent.Acara), fldkgjBGnL9YhTSGS (dari EventKEP.Events)
- Data Pengajar KEP: fldvKXMt3yunX41DJ (dari SubEvent.Pengajar)
- Paroki (tbl8sfqU6G47orPpn): fldMzOCm7UVQGQhgt (dari AkunKEP.Paroki), fldu2eORn3yKTaORS (dari Pengelenggara KEP.Paroki)
- SubEvent: fldxN1CIBE5PebFaA (dari Pendaftaran Events.Pertemuan Hadir)
