import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createRecords, listRecords, updateRecords, type AtRecord } from "@/lib/airtable/client";
import { EVENT_ID_FIELD, F, PENDAFTARAN_CREATED, T, TEAM_UMAT_CREATED, TEAM_UMAT_HAPUS, TEAM_UMAT_MENINGGAL, pickPublicRegistration } from "@/lib/airtable/schema";
import { logAudit } from "@/lib/audit/log";
import { mailConfigured, sendMail } from "@/lib/email";
import { limitKey, rateLimit } from "@/lib/ratelimit";
import { invalidateKepCache, normEmail, normPhone } from "@/lib/kep/readModel";
import { cachedList } from "@/lib/airtable/cache";
import { KEP_FIELDS } from "@/lib/auth/guard";

const REC_ID = /^rec[A-Za-z0-9]{10,}$/;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown): string => {
  if (Array.isArray(v)) return v.length ? str(v[0]) : "";
  if (v && typeof v === "object" && "name" in v) return str((v as { name: unknown }).name);
  return typeof v === "string" ? v.trim() : "";
};
const blank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// ---------------------------------------------------------------------------------------------
// WhatsApp normalization
// ---------------------------------------------------------------------------------------------
/** 0812-3456-789, +62 812 3456 789, 62 812-3456-789 -> 628123456789; null when it is not an Indonesian mobile number. */
export function normalizeWa(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  let d = normPhone(raw);
  if (!d) return null;
  if (d.startsWith("620")) d = `62${d.slice(3)}`; // "+62 0812..."
  return /^628\d{7,12}$/.test(d) ? d : null;
}

// ---------------------------------------------------------------------------------------------
// Registration token: base64url({e: Events record id, v: version}) "." base64url(HMAC-SHA256)
// Bumping TOKEN_VERSION invalidates every issued link. Carries no personal data.
// ---------------------------------------------------------------------------------------------
/** First link version. A rotation marker (AuditKEP "link_daftar_rotasi") raises it; older links then stop working. */
const BASE_LINK_VERSION = 1;
const MAX_TOKEN_LEN = 300;
const DAY_MS = 86_400_000;
export const TOKEN_TTL_DAYS = 120;
export const LINK_ROTASI = "link_daftar_rotasi";

function tokenSecret(): Buffer | null {
  const s = process.env.REG_TOKEN_SECRET;
  return s && Buffer.byteLength(s) >= 32 ? Buffer.from(s) : null;
}
const mac = (secret: Buffer, payload: string) => createHmac("sha256", secret).update(payload).digest();

/** A public link lives 120 days, or until the end of Tanggal Selesai (WIB), whichever comes first. */
export function registrationTokenExpiry(now: Date, tanggalSelesai?: string | null): Date {
  const cap = new Date(now.getTime() + TOKEN_TTL_DAYS * DAY_MS);
  const m = typeof tanggalSelesai === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(tanggalSelesai) : null;
  if (!m) return cap;
  const end = new Date(`${m[1]}T23:59:59.999+07:00`);
  return Number.isNaN(end.getTime()) || end.getTime() > cap.getTime() ? cap : end;
}

/**
 * Payload: event id `e`, link version `v` (rotation counter), issued-at `i` and expiry `x` (epoch seconds).
 * No personal data. Tokens issued before expiry/rotation existed ({e, v:1}) keep verifying.
 */
export function signRegistrationToken(eventId: string, opts: { version?: number; expiresAt?: Date; now?: Date } = {}): string {
  if (typeof eventId !== "string" || !REC_ID.test(eventId)) throw new Error("Invalid event id");
  const secret = tokenSecret();
  if (!secret) throw new Error("REG_TOKEN_SECRET must be at least 32 bytes");
  const version = opts.version ?? BASE_LINK_VERSION;
  if (!Number.isInteger(version) || version < 1) throw new Error("Invalid link version");
  const now = opts.now ?? new Date();
  const exp = opts.expiresAt ?? registrationTokenExpiry(now);
  const payload = Buffer.from(
    JSON.stringify({ e: eventId, v: version, i: Math.floor(now.getTime() / 1000), x: Math.floor(exp.getTime() / 1000) }),
  ).toString("base64url");
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

/** Signature, shape and expiry only (no I/O). */
function parseRegistrationToken(token: string, now: Date): { eventId: string; version: number } | null {
  try {
    const secret = tokenSecret();
    if (!secret || typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LEN) return null;
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const given = Buffer.from(parts[1], "base64url");
    const expected = mac(secret, parts[0]);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { e?: unknown; v?: unknown; x?: unknown };
    if (typeof p.e !== "string" || !REC_ID.test(p.e)) return null;
    if (typeof p.v !== "number" || !Number.isInteger(p.v) || p.v < 1) return null;
    if (p.x !== undefined && (typeof p.x !== "number" || !Number.isFinite(p.x) || p.x * 1000 <= now.getTime())) return null;
    return { eventId: p.e, version: p.v };
  } catch {
    return null;
  }
}

export function verifyRegistrationToken(token: string, now: Date = new Date()): { eventId: string } | null {
  const t = parseRegistrationToken(token, now);
  return t ? { eventId: t.eventId } : null;
}

/** Highest rotation version recorded for this event (the order of AuditKEP rows does not matter). */
export async function currentLinkVersion(eventId: string): Promise<number> {
  if (typeof eventId !== "string" || !REC_ID.test(eventId)) return BASE_LINK_VERSION;
  const AU = F.auditKep;
  const rows = await listRecords(T.auditKep, {
    fields: [AU.aksi, AU.targetId, AU.sesudah],
    filterByFormula: `AND({${AU.aksi}}="${LINK_ROTASI}",{${AU.targetId}}="${eventId}")`,
  });
  let v = BASE_LINK_VERSION;
  for (const r of rows) {
    if (r.fields[AU.aksi] !== LINK_ROTASI || r.fields[AU.targetId] !== eventId) continue;
    try {
      const n = (JSON.parse(String(r.fields[AU.sesudah] ?? "")) as { v?: unknown }).v;
      if (typeof n === "number" && Number.isInteger(n) && n > v) v = n;
    } catch {
      /* not one of ours */
    }
  }
  return v;
}

/** Public entry points use this: valid signature, not expired, and not older than the latest rotation. */
export async function verifyRegistrationTokenCurrent(token: string, now: Date = new Date()): Promise<{ eventId: string } | null> {
  const t = parseRegistrationToken(token, now);
  if (!t) return null;
  return t.version >= (await currentLinkVersion(t.eventId)) ? { eventId: t.eventId } : null;
}

// ---------------------------------------------------------------------------------------------
// Input validation (unknown keys are stripped)
// ---------------------------------------------------------------------------------------------
const NO_CTRL = /^[^\u0000-\u001f\u007f]*$/;
const TEXT_OK = /^[^\u0000-\u0008\u000b-\u001f\u007f]*$/; // multi-line text may contain \n and \t
const line = (label: string, min: number, max: number) =>
  z
    .string({ error: `${label} wajib diisi` })
    .trim()
    .min(min, { error: `${label} wajib diisi` })
    .max(max, { error: `${label} terlalu panjang (maksimal ${max} karakter)` })
    .regex(NO_CTRL, { error: `${label} mengandung karakter yang tidak diizinkan` });
// Conservative: unicode letters, spaces and . ' ’ - , only (no digits, @, :, /, <, >), so URLs/markup cannot ride in emails.
const NAME_OK = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’,-]*$/u;
// "evil.id" / "www.x": a word of 3+ letters directly followed by a dot and a letter. "S.Pd." and "Dr." pass.
const LOOKS_LIKE_DOMAIN = /\p{L}{3,}\.\p{L}/u;
const nameField = (label: string, min: number) =>
  z
    .string({ error: `${label} wajib diisi` })
    .trim()
    .min(min, { error: `${label} wajib diisi` })
    .max(100, { error: `${label} terlalu panjang (maksimal 100 karakter)` })
    .regex(NAME_OK, { error: `${label} hanya boleh berisi huruf, spasi, titik, koma, apostrof dan tanda hubung` })
    .refine((v) => !LOOKS_LIKE_DOMAIN.test(v), { error: `${label} tidak boleh berisi alamat web` });
const longText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `${label} terlalu panjang (maksimal ${max} karakter)` })
    .regex(TEXT_OK, { error: `${label} mengandung karakter yang tidak diizinkan` })
    .optional();

function plausibleBirth(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  const now = new Date();
  const age = now.getUTCFullYear() - y - (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d) ? 1 : 0);
  return dt.getTime() <= now.getTime() && age >= 5 && age <= 110;
}

const Doa = z.object({
  nama: line("Nama pendukung doa", 2, 100),
  kontak: line("Kontak pendukung doa", 3, 60),
});

const waField = z
  .string({ error: "Nomor WhatsApp wajib diisi" })
  .max(40, { error: "Nomor WhatsApp tidak valid" })
  .transform((v, ctx) => {
    const n = normalizeWa(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Nomor WhatsApp tidak valid" });
      return z.NEVER;
    }
    return n;
  });
const emailField = z
  .string({ error: "Email wajib diisi" })
  .trim()
  .toLowerCase()
  .max(254, { error: "Email terlalu panjang" })
  .pipe(z.email({ error: "Email tidak valid" }));

export const PesertaInput = z.object({
  namaLengkap: nameField("Nama lengkap", 2),
  namaBaptis: z.preprocess((v) => (v === "" ? undefined : v), nameField("Nama baptis", 1).optional()),
  jenisKelamin: z.enum(["Pria", "Wanita"], { error: "Pilih jenis kelamin" }),
  tanggalLahir: z.string({ error: "Tanggal lahir wajib diisi" }).refine(plausibleBirth, { error: "Tanggal lahir tidak valid" }),
  wa: waField,
  email: emailField,
  alamat: line("Alamat", 5, 300),
  parokiAsalId: z.string({ error: "Pilih paroki asal" }).regex(REC_ID, { error: "Pilih paroki asal" }),
  statusPernikahan: z.enum(["Single", "Menikah", "Tidak Menikah"], { error: "Pilih status pernikahan" }),
  kontakDarurat: line("Kontak darurat", 3, 200),
  pendukungDoa: z.array(Doa, { error: "Isi dua pendukung doa" }).length(2, { error: "Isi tepat dua pendukung doa" }),
  riwayatPenyakit: longText("Riwayat penyakit", 1000),
  riwayatAlergi: longText("Riwayat alergi", 1000),
  obatRutin: longText("Obat rutin", 1000),
  persetujuanKesehatan: z.boolean().optional(),
}).superRefine((v, ctx) => {
  const hasHealth = [v.riwayatPenyakit, v.riwayatAlergi, v.obatRutin].some((x) => !!x);
  if (hasHealth && v.persetujuanKesehatan !== true)
    ctx.addIssue({ code: "custom", path: ["persetujuanKesehatan"], message: "Centang persetujuan penggunaan data kesehatan untuk melanjutkan" });
});
const hasHealthData = (v: RegInput) => [v.riwayatPenyakit, v.riwayatAlergi, v.obatRutin].some((x) => !!x);
export type PesertaInput = z.output<typeof PesertaInput>;

/**
 * Walk-in at the Absen screen (spec 8b.8): name and WhatsApp only, email optional. No health fields, so there is
 * no consent to record; the rest of the data is completed later (the hub shows "Data belum lengkap").
 */
export const WalkInInput = z.object({
  namaLengkap: nameField("Nama lengkap", 2),
  wa: waField,
  email: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), emailField.optional()),
});
export type WalkInInput = z.output<typeof WalkInInput>;

/** What registration needs: the full public form fits it, and so does a walk-in (everything but name and WA optional). */
type RegInput = {
  namaLengkap: string;
  wa: string;
  email?: string;
  namaBaptis?: string;
  jenisKelamin?: string;
  tanggalLahir?: string;
  alamat?: string;
  parokiAsalId?: string;
  statusPernikahan?: string;
  kontakDarurat?: string;
  pendukungDoa?: { nama: string; kontak: string }[];
  riwayatPenyakit?: string;
  riwayatAlergi?: string;
  obatRutin?: string;
};

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------
/** Unknown event, KEP not Disetujui, or registration window over. Callers must not say which. */
export class RegistrationClosedError extends Error {
  constructor() {
    super("Pendaftaran tidak tersedia");
    this.name = "RegistrationClosedError";
  }
}
export class RegistrationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationInputError";
  }
}

// ---------------------------------------------------------------------------------------------
// KEP lookup
// ---------------------------------------------------------------------------------------------
const WIB_OFFSET_MS = 7 * 3600_000;
const wibDate = (d: Date) => new Date(d.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
const INACTIVE = new Set(["Batal", "Dobel Daftar"]);
const DUPLICATE_STATUS = "Dobel Daftar"; // field map choice for exactly this case

export type OpenKep = { eventId: string; eventKepId: string; nama: string };

/** The KEP behind an Events record, only if EVERY linked EventKEP is Disetujui and today (WIB) is not after Tanggal Selesai. */
export async function resolveOpenKep(eventId: string, now = new Date()): Promise<OpenKep> {
  if (typeof eventId !== "string" || !REC_ID.test(eventId)) throw new RegistrationClosedError();
  // Shared cached EventKEP read (same field set as the scope guard). A closed answer is re-checked once against a
  // refresh older than 5 s (just approved on another instance); an open answer may be up to 45 s old, which only
  // matters for a KEP that closes by date (checked below with today's date) - approval is never withdrawn.
  const keps = await openKeps(eventId, now, await cachedList(T.eventKep, KEP_FIELDS)).catch(async (e) => {
    if (!(e instanceof RegistrationClosedError)) throw e;
    return openKeps(eventId, now, await cachedList(T.eventKep, KEP_FIELDS, undefined, { maxAgeMs: 5_000 }));
  });
  const ev = await eventInfo(eventId);
  if (!ev) throw new RegistrationClosedError();
  return { eventId, eventKepId: keps[0].id, nama: ev.nama || "KEP" };
}

async function openKeps(eventId: string, now: Date, all: AtRecord[]): Promise<AtRecord[]> {
  const keps = all.filter((k) => ids(k.fields[F.eventKep.events]).includes(eventId));
  if (keps.length === 0 || !keps.every((k) => str(k.fields[F.eventKep.statusPersetujuan]) === "Disetujui")) throw new RegistrationClosedError();
  // Open only through Tanggal Selesai, as a calendar date in Asia/Jakarta (WIB).
  const today = wibDate(now);
  for (const k of keps) {
    const end = str(k.fields[F.eventKep.tanggalSelesai]).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(end) && today > end) throw new RegistrationClosedError();
  }
  return keps;
}

/** Name and EventID text of one Events row (cached 10 min; the EventID never changes). Null: no such event. */
async function eventInfo(eventId: string): Promise<{ nama: string; eventIdText: string } | null> {
  const rows = await cachedList(T.events, [F.events.namaAcara, EVENT_ID_FIELD], `RECORD_ID()="${eventId}"`, { ttlMs: 10 * 60_000 });
  const r = rows.find((x) => x.id === eventId);
  return r ? { nama: str(r.fields[F.events.namaAcara]), eventIdText: str(r.fields[EVENT_ID_FIELD]) } : null;
}

// ---------------------------------------------------------------------------------------------
// Person (MasterData TeamUmat): find by normalized WA or lowercased email, never overwrite
// ---------------------------------------------------------------------------------------------
const U = F.teamUmat;
const PERSON_FIELDS = [U.namaLengkap, U.email, U.noWhatsapp, TEAM_UMAT_CREATED, TEAM_UMAT_HAPUS, TEAM_UMAT_MENINGGAL];
/** Soft-deleted ("Hapus") and deceased rows are tombstones: never matched, never a race winner. */
const tombstone = (r: AtRecord) => r.fields[TEAM_UMAT_HAPUS] === true || !blank(r.fields[TEAM_UMAT_MENINGGAL]);
/** ONE normalization for stored and submitted numbers. */
const storedWa = (v: unknown) => normalizeWa(str(v)) ?? normPhone(v);

const createdOf = (r: AtRecord, field: string) => (typeof r.fields[field] === "string" ? (r.fields[field] as string) : "9999");
const byAge = (field: string) => (a: AtRecord, b: AtRecord) => createdOf(a, field).localeCompare(createdOf(b, field)) || a.id.localeCompare(b.id);

const WA_CLEAN = `SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({${U.noWhatsapp}}," ",""),"-",""),"+",""),"(",""),")",""),".","")`;

async function findMatches(input: RegInput): Promise<{ byWa: AtRecord[]; byEmail: AtRecord[] }> {
  // The formula only narrows the read; the exact match is re-checked in code with the shared normalization.
  // (no email submitted, e.g. a walk-in: match on WhatsApp only - an empty address must never match every blank email)
  const byWaFormula = `FIND(${q(input.wa.slice(-9))},${WA_CLEAN})>0`;
  const filterByFormula = input.email ? `OR(LOWER(TRIM({${U.email}}))=${q(input.email)},${byWaFormula})` : byWaFormula;
  const rows = await listRecords(T.teamUmat, { fields: PERSON_FIELDS, filterByFormula });
  const sorted = rows.filter((r) => !tombstone(r)).sort(byAge(TEAM_UMAT_CREATED));
  return {
    byWa: sorted.filter((r) => storedWa(r.fields[U.noWhatsapp]) === input.wa),
    byEmail: input.email ? sorted.filter((r) => normEmail(r.fields[U.email]) === input.email) : [],
  };
}

type PersonCtx = { eventId?: string; actorEmail?: string; defer?: (fn: () => Promise<unknown>) => void };
/** Signed-in actor email, or the "publik" marker (Sesudah.actorType; AuditKEP.Pelaku is an email field). */
const actorOf = (actorEmail?: string) => (actorEmail ? { actorEmail } : { actorType: "publik" as const });
/** mailTo/mailName: where the confirmation goes. For an existing person that is the address ON FILE, never the submitted one. */
export type ResolvedPerson = { personId: string; created: boolean; mailTo: string | null; mailName: string | null };

const safeName = (v: unknown): string | null => {
  const n = str(v).slice(0, 100);
  return NAME_OK.test(n) && !LOOKS_LIKE_DOMAIN.test(n) ? n : null;
};
const onFileEmail = (r: AtRecord) => normEmail(r.fields[U.email]);

/** Non-critical audit: deferred when the caller can (response timing), else inline and best effort. */
async function softAudit(ctx: PersonCtx, entry: Parameters<typeof logAudit>[0]) {
  if (ctx.defer) ctx.defer(() => logAudit(entry));
  else {
    try {
      await logAudit(entry);
    } catch {
      /* best effort */
    }
  }
}

async function resolvePerson(input: RegInput, ctx: PersonCtx = {}): Promise<ResolvedPerson> {
  const { byWa, byEmail } = await findMatches(input);
  const common = byWa.find((r) => byEmail.some((e) => e.id === r.id));
  const chosen = common ?? byWa[0] ?? byEmail[0];
  const actor = actorOf(ctx.actorEmail);
  if (!common && byWa[0] && byEmail[0]) {
    // WA and email belong to two different people: never merge. Register against the WA match and flag it.
    await logAudit({
      ...actor,
      action: "registrasi_konflik_identitas",
      targetId: ctx.eventId ?? "registrasi",
      after: { waPersonId: byWa[0].id, emailPersonId: byEmail[0].id },
    });
  }

  if (chosen) {
    // An existing person is NEVER modified (no overwrite, no blank fill). Only the registration row is created.
    const mailTo = onFileEmail(chosen);
    if (input.email && mailTo !== input.email)
      await softAudit(ctx, {
        ...actor,
        action: "registrasi_untuk_orang_terdaftar",
        targetId: ctx.eventId ?? "registrasi",
        after: { personId: chosen.id, emailTersimpan: mailTo ? "ada" : "kosong" },
      });
    return { personId: chosen.id, created: false, mailTo, mailName: safeName(chosen.fields[U.namaLengkap]) };
  }

  const fields = pickPublicRegistration(T.teamUmat, {
    [U.namaLengkap]: input.namaLengkap,
    ...(input.namaBaptis ? { [U.namaBaptis]: input.namaBaptis } : {}),
    ...(input.email ? { [U.email]: input.email } : {}),
    [U.noWhatsapp]: input.wa,
    ...(input.tanggalLahir ? { [U.tanggalLahir]: input.tanggalLahir } : {}),
    ...(input.alamat ? { [U.alamatTinggal]: input.alamat } : {}),
    ...(input.jenisKelamin ? { [U.jenisKelamin]: input.jenisKelamin } : {}),
    ...(input.statusPernikahan ? { [U.statusPernikahan]: input.statusPernikahan } : {}),
    ...(input.parokiAsalId ? { [U.paroki]: [input.parokiAsalId] } : {}),
  });
  const [made] = await createRecords(T.teamUmat, [fields]);
  // Another instance may have created the same person at the same moment: the oldest row wins (nothing is deleted).
  const again = await findMatches(input);
  const same = new Map([...again.byWa, ...again.byEmail].map((r) => [r.id, r]));
  const winner = [...same.values()].sort(byAge(TEAM_UMAT_CREATED))[0];
  if (winner && winner.id !== made.id && same.has(made.id)) {
    await softAudit(ctx, { ...actor, action: "registrasi_person_ganda", targetId: ctx.eventId ?? "registrasi", after: { dipakai: winner.id, yatim: made.id } });
    return { personId: winner.id, created: false, mailTo: onFileEmail(winner), mailName: safeName(winner.fields[U.namaLengkap]) };
  }
  return { personId: made.id, created: true, mailTo: input.email ?? null, mailName: input.namaLengkap };
}

export async function findOrCreatePerson(input: RegInput, ctx: PersonCtx = {}): Promise<{ personId: string; created: boolean }> {
  const r = await resolvePerson(input, ctx);
  if (r.created) invalidateKepCache(T.teamUmat);
  return { personId: r.personId, created: r.created };
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------
const P = F.pendaftaranEvents;
const tails = new Map<string, Promise<unknown>>();
/** Serializes registrations per event inside this process (cross-instance races are handled by the re-check). */
async function withLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

async function activeRows(kep: OpenKep, personId: string): Promise<AtRecord[]> {
  const eventIdText = (await eventInfo(kep.eventId))?.eventIdText ?? ""; // empty: unfiltered read (fallback)
  const rows = await listRecords(T.pendaftaranEvents, {
    fields: [P.event, P.teamUmat, P.statusPendaftaran, PENDAFTARAN_CREATED],
    ...(eventIdText ? { filterByFormula: `FIND(${q(eventIdText)},ARRAYJOIN({${P.event}}))>0` } : {}),
  });
  return rows
    .filter((r) => ids(r.fields[P.event]).includes(kep.eventId) && ids(r.fields[P.teamUmat]).includes(personId) && !INACTIVE.has(str(r.fields[P.statusPendaftaran])))
    .sort(byAge(PENDAFTARAN_CREATED));
}

export type RegisterResult = { status: "registered" | "already_registered"; pendaftaranId: string; emailTerkirim: boolean };

/**
 * Registers a peserta for an approved KEP. One active (not Batal) registration per person and event; a repeat
 * answers already_registered without a new row. Exactly one confirmation email per call, sent after the writes;
 * an email failure never undoes or duplicates anything.
 */
export async function registerPeserta(
  eventId: string,
  rawInput: unknown,
  opts: { actorEmail?: string; defer?: (fn: () => Promise<unknown>) => void } = {},
): Promise<RegisterResult> {
  return registerCore(eventId, PesertaInput.parse(rawInput), opts);
}

/** Walk-in registration (name + WhatsApp, email optional) by a signed-in PIC / Admin: same dedupe, never edits an existing person. */
export async function registerWalkIn(eventId: string, rawInput: unknown, opts: { actorEmail: string }): Promise<RegisterResult> {
  return registerCore(eventId, WalkInInput.parse(rawInput), opts);
}

async function registerCore(
  eventId: string,
  input: RegInput,
  opts: { actorEmail?: string; defer?: (fn: () => Promise<unknown>) => void },
): Promise<RegisterResult> {
  const kep = await resolveOpenKep(eventId);
  const out = await withLock(kep.eventId, async () => {
    const kepAgain = await resolveOpenKep(eventId); // the status may have changed while we waited for the lock
    if (input.parokiAsalId !== undefined) {
      const parokis = await cachedList(T.paroki, [F.paroki.nama]);
      if (!parokis.some((p) => p.id === input.parokiAsalId)) throw new RegistrationInputError("Paroki asal tidak valid");
    }
    const person = await resolvePerson(input, { eventId: kepAgain.eventId, actorEmail: opts.actorEmail, defer: opts.defer });

    const existing = await activeRows(kepAgain, person.personId);
    if (existing.length > 0) return { kep: kepAgain, person, status: "already_registered" as const, id: existing[0].id };

    // Consent is recorded (AuditKEP only, no Airtable field) BEFORE any health data is stored; failure aborts.
    if (hasHealthData(input))
      await logAudit({
        ...actorOf(opts.actorEmail),
        action: "persetujuan_data_kesehatan",
        targetId: `${kepAgain.eventId}:${person.personId}`,
        after: { waktu: new Date().toISOString() },
      });
    const fields = pickPublicRegistration(T.pendaftaranEvents, {
      [P.event]: [kepAgain.eventId],
      [P.teamUmat]: [person.personId],
      [P.kategoriKepesertaan]: "Peserta",
      [P.statusPendaftaran]: "Daftar",
      ...(input.pendukungDoa ? { [P.pendukungDoa]: input.pendukungDoa.map((d) => `${d.nama} (${d.kontak})`).join("; ") } : {}),
      ...(input.kontakDarurat ? { [P.kontakDarurat]: input.kontakDarurat } : {}),
      ...(input.riwayatPenyakit ? { [P.riwayatPenyakit]: input.riwayatPenyakit } : {}),
      ...(input.riwayatAlergi ? { [P.riwayatAlergi]: input.riwayatAlergi } : {}),
      ...(input.obatRutin ? { [P.obatRutin]: input.obatRutin } : {}),
    });
    const [made] = await createRecords(T.pendaftaranEvents, [fields]);

    // Re-check: if another instance registered the same person meanwhile, the oldest row wins and ours is
    // marked Dobel Daftar (never deleted).
    const rows = await activeRows(kepAgain, person.personId);
    const winner = rows[0];
    if (winner && winner.id !== made.id) {
      try {
        await updateRecords(T.pendaftaranEvents, [{ id: made.id, fields: pickPublicRegistration(T.pendaftaranEvents, { [P.statusPendaftaran]: DUPLICATE_STATUS }) }]);
      } catch {
        try {
          await logAudit({ ...actorOf(opts.actorEmail), action: "registrasi_duplikat_gagal_ditandai", targetId: made.id, after: { pemenang: winner.id } });
        } catch {
          /* still answer already_registered */
        }
      }
      return { kep: kepAgain, person, status: "already_registered" as const, id: winner.id };
    }
    return { kep: kepAgain, person, status: "registered" as const, id: made.id };
  });

  invalidateKepCache(T.pendaftaranEvents);
  if (out.person.created) invalidateKepCache(T.teamUmat);

  // The confirmation goes to the address ON FILE of the person (for a new person: the submitted one). A matched
  // person without an email on file gets none. Wording is neutral; "already registered" only reaches the owner.
  const to = out.person.mailTo;
  const data = {
    link: "",
    nama: out.person.mailName ?? undefined,
    kepNama: out.kep.nama,
    jenis: out.status === "already_registered" ? ("sudah_terdaftar" as const) : ("diterima" as const),
  };
  const send = async () => {
    if (!to) return false;
    // Mail-bomb guard on the RECIPIENT (the address on file may be someone else's): over the limit, skip silently.
    const lim = await rateLimit(limitKey("daftar-mail-penerima", to), 3, 3600);
    if (!lim.ok) {
      try {
        await logAudit({ ...actorOf(opts.actorEmail), action: "email_konfirmasi_dilewati", targetId: out.id, after: { alasan: "batas penerima" } });
      } catch {
        /* soft */
      }
      return false;
    }
    try {
      await sendMail(to, "pendaftaran_kep", data);
      return mailConfigured();
    } catch {
      console.error("Email konfirmasi pendaftaran gagal dikirim");
      return false;
    }
  };
  if (opts.defer) {
    opts.defer(send);
    return { status: out.status, pendaftaranId: out.id, emailTerkirim: false };
  }
  return { status: out.status, pendaftaranId: out.id, emailTerkirim: await send() };
}
