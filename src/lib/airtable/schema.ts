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

// Primary field of Events (formula "EventID", date prefix + name). Read-only; deliberately NOT in F.events so
// it never enters the write allowlist.
export const EVENT_ID_FIELD = "fldhpu7dbyYUETwuY";

// Value of Data Pengajar KEP "Status" (fldi7BZu04g8hHksR, singleSelect) that means an active pewarta
// (verified live: it is the only choice).
export const PENGAJAR_STATUS_AKTIF = "Aktif";

// Data Pengajar KEP fields that are READ ONLY for the app (deliberately outside F so they never enter a write
// allowlist). noHp is SENSITIVE: request it only in a dedicated single-record read for an authorized viewer.
export const PENGAJAR_READ = {
  noHp: "fldF6kmbcQpu0S8xq",
  bab: "fldPkNCOvkAMeamXY", // link to BabKEP
  subEvent: "fldvKXMt3yunX41DJ", // link to SubEvent (inverse of SubEvent.Pengajar)
} as const;

// createdTime fields (read only, outside F so they never enter a write allowlist). Used to pick a deterministic
// winner when two concurrent registrations raced. IDs from the live field map (TeamUmat "Created",
// Pendaftaran Events "CreatedTimeAuto").
export const TEAM_UMAT_CREATED = "fldRztRSisBK7yzng";
export const PENDAFTARAN_CREATED = "fld0R2DJqFnFZU2sj";
// TeamUmat tombstones (read only): "Hapus" checkbox and "Tanggal Meninggal" date. Such rows are never matched.
export const TEAM_UMAT_HAPUS = "fldxZvnqVvAH4aWyd";
export const TEAM_UMAT_MENINGGAL = "fldhCRFZpi4cx0zRJ";

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
  paroki: {
    nama: "fldskPQJ7WQgCVODZ", // "Nama Paroki" (read-only use; the table is not in ALLOWED)
  },
  eventKep: {
    statusPersetujuan: "fldVi4F0TJit1MbmI",
    catatanSep: "fldhr8M2mdO1wHVPe",
    events: "fldyZwU5mLOjjatLs",
    penyelenggara: "fldSavviLVAE5xkxc",
    submittedBy: "fldIcKDXLxLda0giU", // email
    angkatan: "fldQkxnFnG4pgjhs0", // number
    tanggalMulai: "fldvco2dffbupb92s", // date
    tanggalSelesai: "fldR5nfZ1mFSkEBBi", // date
    jenis: "fldSGYZSTOxZyxvG3", // singleSelect KEP/SEP
  },
  penyelenggaraKep: {
    paroki: "fld2sPNpixsNArdjf",
    penyelenggara: "fldIrpPwvByuQjm1a", // name (singleLineText)
    jenis: "fldfiKkzzpZw4o7jG", // singleSelect; choice "KEP" per ruling R6 (option text not re-read)
  },
  pengajarKep: {
    nama: "fldYEMM3xGzWnAJuX",
    status: "fldi7BZu04g8hHksR",
    photo: "fldu2pMyDKF9bMTiF",
    linkYoutube: "fld8hjcXk5yxWO31p",
    bioSingkat: "fldVMLPJuzL8673mZ",
  },
  babKep: {
    bab: "fldXsQ5MvJsUpVMYd", // singleSelect "Bab" name (read only; table is not in ALLOWED)
    tanggal: "fldgOrwm781Aix64w", // date (read only; used by scripts/map-legacy.ts)
    pengajar: "fldWmgPEIYE1mOtVQ", // link to Data Pengajar KEP
    eventKep: "fldad1ruhQphCh5x8", // link to EventKEP
  },
  subEvent: {
    agenda: "fld6n7fszdA2YmmzM",
    acara: "fldG03oIWIqrUgGLX",
    urutan: "fldaZPMpQnLjHh5wZ",
    tanggal: "fldUjbwLw0J6tMF0h", // type: date (YYYY-MM-DD, no time; verified live), compared as a WIB calendar date
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

// Restricted fields: never in the generic allowlist. Only SEP may write them (pickAllowedForRole), or
// server code that sets them from trusted data (e.g. penyelenggara on create from session.parokiId)
// by passing them explicitly as `extra` to the client. Never from request input.
export const RESTRICTED: Record<string, Set<string>> = {
  [T.eventKep]: new Set([
    F.eventKep.statusPersetujuan,
    F.eventKep.catatanSep,
    F.eventKep.penyelenggara,
    F.eventKep.submittedBy,
    F.eventKep.angkatan,
    F.eventKep.tanggalMulai,
    F.eventKep.tanggalSelesai,
    F.eventKep.jenis,
  ]),
  [T.penyelenggaraKep]: new Set([F.penyelenggaraKep.paroki, F.penyelenggaraKep.penyelenggara, F.penyelenggaraKep.jenis]),
};
const without = (o: Record<string, string>, drop?: Set<string>) =>
  new Set<string>(Object.values(o).filter((v) => !drop?.has(v)));

export const ALLOWED: Record<string, Set<string>> = {
  [T.events]: setOf(F.events),
  [T.pendaftaranEvents]: setOf(F.pendaftaranEvents),
  [T.teamUmat]: setOf(F.teamUmat),
  [T.eventKep]: without(F.eventKep, RESTRICTED[T.eventKep]),
  [T.penyelenggaraKep]: without(F.penyelenggaraKep, RESTRICTED[T.penyelenggaraKep]),
  // Only the SEP-editable profile fields are writable; name, status, photo, links and NoHP never are.
  [T.pengajarKep]: new Set<string>([F.pengajarKep.linkYoutube, F.pengajarKep.bioSingkat]),
  [T.subEvent]: setOf(F.subEvent),
  [T.akunKep]: setOf(F.akunKep),
  [T.auditKep]: setOf(F.auditKep),
};

/** `extra`: restricted field IDs the caller is explicitly allowed to write (see RESTRICTED). */
export function pickAllowed(tableId: string, fields: Record<string, unknown>, extra?: Set<string>): Record<string, unknown> {
  const allowed = ALLOWED[tableId];
  const out: Record<string, unknown> = {};
  if (!allowed) throw new Error(`No write allowlist for table ${tableId}`); // fail closed
  for (const [k, v] of Object.entries(fields)) if (allowed.has(k) || extra?.has(k)) out[k] = v;
  return out;
}

/** Restricted fields a role may write on a table: SEP only. */
export const restrictedFor = (tableId: string, role: string): Set<string> =>
  role === "SEP" ? (RESTRICTED[tableId] ?? new Set<string>()) : new Set<string>();

/** Field filter for request-derived data: restricted fields survive only for SEP. */
export const pickAllowedForRole = (tableId: string, role: string, fields: Record<string, unknown>) =>
  pickAllowed(tableId, fields, restrictedFor(tableId, role));

/**
 * Public / manual peserta registration may write ONLY these fields. Health data and the emergency contact live on
 * Pendaftaran Events (per registration); TeamUmat gets personal fields only. jabatan/BPK/admin fields are absent
 * on purpose, whatever the request body contains.
 */
export const PUBLIC_REG_ALLOWED: Record<string, Set<string>> = {
  // Explicit on purpose: a field added to F.teamUmat later (jabatan BPK, roles...) must NOT become publicly writable.
  [T.teamUmat]: new Set<string>([
    F.teamUmat.namaLengkap,
    F.teamUmat.namaBaptis,
    F.teamUmat.email,
    F.teamUmat.noWhatsapp,
    F.teamUmat.tanggalLahir,
    F.teamUmat.alamatTinggal,
    F.teamUmat.jenisKelamin,
    F.teamUmat.statusPernikahan,
    F.teamUmat.paroki,
  ]),
  [T.pendaftaranEvents]: new Set<string>([
    F.pendaftaranEvents.event,
    F.pendaftaranEvents.teamUmat,
    F.pendaftaranEvents.kategoriKepesertaan,
    F.pendaftaranEvents.statusPendaftaran,
    F.pendaftaranEvents.pendukungDoa,
    F.pendaftaranEvents.kontakDarurat,
    F.pendaftaranEvents.riwayatPenyakit,
    F.pendaftaranEvents.riwayatAlergi,
    F.pendaftaranEvents.obatRutin,
  ]),
};

/** pickAllowed narrowed to the public-registration allowlist (and never any restricted field). */
export function pickPublicRegistration(tableId: string, fields: Record<string, unknown>): Record<string, unknown> {
  const allow = PUBLIC_REG_ALLOWED[tableId];
  const out: Record<string, unknown> = {};
  if (!allow) return out;
  for (const [k, v] of Object.entries(pickAllowed(tableId, fields))) if (allow.has(k)) out[k] = v;
  return out;
}

/**
 * Read allowlist: the only field IDs the Airtable client may request or return, per table. Everything else in a
 * response (e.g. TeamUmat BPK-board fields, personal data the app does not use) is stripped in the client before
 * any caller sees it. Fields of tables that are not listed here can never be read.
 */
export const READ_ALLOWED: Record<string, Set<string>> = {
  [T.events]: new Set([...Object.values(F.events), EVENT_ID_FIELD]),
  [T.pendaftaranEvents]: new Set([...Object.values(F.pendaftaranEvents), PENDAFTARAN_CREATED]),
  [T.teamUmat]: new Set([...Object.values(F.teamUmat), TEAM_UMAT_CREATED, TEAM_UMAT_HAPUS, TEAM_UMAT_MENINGGAL]),
  [T.eventKep]: setOf(F.eventKep),
  [T.babKep]: setOf(F.babKep),
  [T.penyelenggaraKep]: setOf(F.penyelenggaraKep),
  [T.pengajarKep]: new Set([...Object.values(F.pengajarKep), ...Object.values(PENGAJAR_READ)]),
  [T.paroki]: setOf(F.paroki),
  [T.subEvent]: setOf(F.subEvent),
  [T.akunKep]: setOf(F.akunKep),
  [T.auditKep]: setOf(F.auditKep),
};
