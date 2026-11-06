// Airtable IDs for base BPK Bandung (appIGR8Duhj3Vsz48).
// Field IDs for existing fields not listed here (e.g. NoHP, jabatan BPK) have NOT
// been looked up yet; add them only after verifying with get_table_schema.

export const T = {
  events: "tblbAIILkeRIwn3kl",
  pendaftaranEvents: "tbltiJ1qDJEwfWPLg",
  teamUmat: "tblwRNtXSVzgzVXuk",
  eventKep: "tbllEWCLGPMwXnVBT",
  babKep: "tblz5q7GDKGcVksLw",
  penyelenggaraKep: "tblH4SN6qpNxJFg35",
  pengajarKep: "tblphUIZPACl1BKpS",
  paroki: "tbl8sfqU6G47orPpn",
  kehadiranEvent: "tblQgU4DawCAXIRdi",
  // new tables (docs/airtable-changes.md)
  subEvent: "tblZ3zq2vB37Dxqfp",
  akunKep: "tbleebgqGzUZPzwes",
  auditKep: "tblyZWZEDw8woCjQ7",
} as const;

export const SEL = {
  kelompokAcaraKep: "sel89ZKeY5BWQgaTL",
} as const;

export const F = {
  events: {
    namaAcara: "fld0d9tIyi4nyTZsM",
    tanggalAcara: "fldoIkx9wLMaKOa38",
    kelompokAcara: "fldhgv2WlvqytF6zA",
    lokasiAcara: "fldY0qw1v0a4fK9Sp",
  },
  pendaftaranEvents: {
    event: "flduf15moMpZSklGL",
    teamUmat: "fldqvA9dTUmWLfRr2",
    statusPendaftaran: "fldNGGEcwHqIsQPct",
    kategoriKepesertaan: "fldIgnkqdrDPz8gCV",
    keterangan: "fld0rpifIKPadBYpe",
    kontakDarurat: "fldumrliAbkcLJJsz",
    riwayatPenyakit: "fldIDrkKEzyPORmVj",
    riwayatAlergi: "fldUDGah0ZmaBUpbC",
    obatRutin: "fldMvsFA7aXXLk3ZH",
    pertemuanHadir: "fld2ylVkRD9BpFLyH",
    pendukungDoa: "fldeGUtCP76Kpzcwo",
  },
  teamUmat: {
    namaLengkap: "fldIpQTSkFB9sU0lo",
    namaBaptis: "fld0P7TE88KvYXORT",
    email: "fldAaQ3zmiLBhp4z9",
    noWhatsapp: "fldzY1Z2QvIIEkYXR",
    tanggalLahir: "fldXGHvqnezzKZSCp",
    alamatTinggal: "fldcQFzBtr9EELTtV",
    jenisKelamin: "fldxpeouH1hcxMzNc",
    statusPernikahan: "fldRKWfGerVT5jcnp",
    paroki: "fldE62NyXuSJLvM8h",
  },
  eventKep: {
    statusPersetujuan: "fldVi4F0TJit1MbmI",
    catatanSep: "fldhr8M2mdO1wHVPe",
    events: "fldyZwU5mLOjjatLs",
    penyelenggara: "fldSavviLVAE5xkxc",
  },
  penyelenggaraKep: {
    paroki: "fld2sPNpixsNArdjf",
  },
  pengajarKep: {
    nama: "fldYEMM3xGzWnAJuX",
    status: "fldi7BZu04g8hHksR",
    photo: "fldu2pMyDKF9bMTiF",
    linkYoutube: "fld8hjcXk5yxWO31p",
    bioSingkat: "fldVMLPJuzL8673mZ",
  },
  subEvent: {
    agenda: "fld6n7fszdA2YmmzM",
    acara: "fldG03oIWIqrUgGLX",
    urutan: "fldaZPMpQnLjHh5wZ",
    tanggal: "fldUjbwLw0J6tMF0h",
    jamMulai: "fld5KQvsCHytRZKGQ",
    jamSelesai: "fldSUdoLGXbHVAhCe",
    pengajar: "fldM6XcvHnkLk8Pf1",
    keterangan: "fldLdr0T6XHgqLwl2",
  },
  akunKep: {
    email: "fldhSj7cXUhRxXJOu",
    nama: "fldUx3sdEOcE8Qgfe",
    peran: "fld59EjsnXN54H9xj",
    paroki: "fldZFNJGpXd4szQ0O",
    hashPassword: "fldtaOmwb0FCSdCOE",
    idGoogle: "fldNR0aLOKTCFod2x",
    rahasiaMfa: "fldIykU3vFQ3OZdqH",
    statusAktif: "fldySiZtvggiAC3u2",
    loginTerakhir: "fldECGrMWK81V0YtY",
    gagalLogin: "fldSzGn8Ul8HU99yi",
    waktuKunci: "fldDdLKILJPHSbnut",
    langkahTotpTerakhir: "fldxXkIOldyt3Fd7E",
  },
  auditKep: {
    aksi: "fldVn2L5B4eSjzmex",
    pelaku: "fld5xTtJt7R1TG0Z5",
    targetId: "fldir7qLRAnIb14Qj",
    sebelum: "fld6BBZ4CpW8NQZrJ",
    sesudah: "fldHhmDBjZSGLtAoI",
    opId: "fldMdPPqsFVvspYMF",
  },
} as const;

// Write allowlist: only explicitly known (non reverse-link) fields may be written.
const setOf = (o: Record<string, string>) => new Set<string>(Object.values(o));

export const ALLOWED: Record<string, Set<string>> = {
  [T.events]: setOf(F.events),
  [T.pendaftaranEvents]: setOf(F.pendaftaranEvents),
  [T.teamUmat]: setOf(F.teamUmat),
  [T.eventKep]: setOf(F.eventKep),
  [T.penyelenggaraKep]: setOf(F.penyelenggaraKep),
  [T.pengajarKep]: setOf(F.pengajarKep),
  [T.subEvent]: setOf(F.subEvent),
  [T.akunKep]: setOf(F.akunKep),
  [T.auditKep]: setOf(F.auditKep),
};

export function pickAllowed(tableId: string, fields: Record<string, unknown>): Record<string, unknown> {
  const allowed = ALLOWED[tableId];
  const out: Record<string, unknown> = {};
  if (!allowed) return out;
  for (const [k, v] of Object.entries(fields)) if (allowed.has(k)) out[k] = v;
  return out;
}
