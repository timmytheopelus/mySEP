import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createRecords, getRecord, listRecords, updateRecords, type AtRecord } from "@/lib/airtable/client";
import { EVENT_ID_FIELD, F, PENDAFTARAN_CREATED, T, TEAM_UMAT_CREATED, pickPublicRegistration } from "@/lib/airtable/schema";
import { logAudit } from "@/lib/audit/log";
import { sendMail } from "@/lib/email";
import { invalidateKepCache, normEmail, normPhone } from "@/lib/kep/readModel";

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
const TOKEN_VERSION = 1;
const MAX_TOKEN_LEN = 300;

function tokenSecret(): Buffer | null {
  const s = process.env.REG_TOKEN_SECRET;
  return s && Buffer.byteLength(s) >= 32 ? Buffer.from(s) : null;
}
const mac = (secret: Buffer, payload: string) => createHmac("sha256", secret).update(payload).digest();

export function signRegistrationToken(eventId: string): string {
  if (typeof eventId !== "string" || !REC_ID.test(eventId)) throw new Error("Invalid event id");
  const secret = tokenSecret();
  if (!secret) throw new Error("REG_TOKEN_SECRET must be at least 32 bytes");
  const payload = Buffer.from(JSON.stringify({ e: eventId, v: TOKEN_VERSION })).toString("base64url");
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

export function verifyRegistrationToken(token: string): { eventId: string } | null {
  try {
    const secret = tokenSecret();
    if (!secret || typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LEN) return null;
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const given = Buffer.from(parts[1], "base64url");
    const expected = mac(secret, parts[0]);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { e?: unknown; v?: unknown };
    if (p.v !== TOKEN_VERSION || typeof p.e !== "string" || !REC_ID.test(p.e)) return null;
    return { eventId: p.e };
  } catch {
    return null;
  }
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

export const PesertaInput = z.object({
  namaLengkap: line("Nama lengkap", 2, 120),
  namaBaptis: z.preprocess((v) => (v === "" ? undefined : v), line("Nama baptis", 1, 80).optional()),
  jenisKelamin: z.enum(["Pria", "Wanita"], { error: "Pilih jenis kelamin" }),
  tanggalLahir: z.string({ error: "Tanggal lahir wajib diisi" }).refine(plausibleBirth, { error: "Tanggal lahir tidak valid" }),
  wa: z
    .string({ error: "Nomor WhatsApp wajib diisi" })
    .max(40, { error: "Nomor WhatsApp tidak valid" })
    .transform((v, ctx) => {
      const n = normalizeWa(v);
      if (!n) {
        ctx.addIssue({ code: "custom", message: "Nomor WhatsApp tidak valid" });
        return z.NEVER;
      }
      return n;
    }),
  email: z
    .string({ error: "Email wajib diisi" })
    .trim()
    .toLowerCase()
    .max(254, { error: "Email terlalu panjang" })
    .pipe(z.email({ error: "Email tidak valid" })),
  alamat: line("Alamat", 5, 300),
  parokiAsalId: z.string({ error: "Pilih paroki asal" }).regex(REC_ID, { error: "Pilih paroki asal" }),
  statusPernikahan: z.enum(["Single", "Menikah", "Tidak Menikah"], { error: "Pilih status pernikahan" }),
  kontakDarurat: line("Kontak darurat", 3, 200),
  pendukungDoa: z.array(Doa, { error: "Isi dua pendukung doa" }).length(2, { error: "Isi tepat dua pendukung doa" }),
  riwayatPenyakit: longText("Riwayat penyakit", 1000),
  riwayatAlergi: longText("Riwayat alergi", 1000),
  obatRutin: longText("Obat rutin", 1000),
});
export type PesertaInput = z.output<typeof PesertaInput>;

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
const DAY_MS = 86_400_000;
const CLOSED_GRACE_DAYS = 2;
const INACTIVE = new Set(["Batal", "Dobel Daftar"]);

export type OpenKep = { eventId: string; eventKepId: string; nama: string };

/** The KEP behind an Events record, only if EVERY linked EventKEP is Disetujui and its end date is not long past. */
export async function resolveOpenKep(eventId: string, now = new Date()): Promise<OpenKep> {
  if (typeof eventId !== "string" || !REC_ID.test(eventId)) throw new RegistrationClosedError();
  const all = await listRecords(T.eventKep, {
    fields: [F.eventKep.events, F.eventKep.statusPersetujuan, F.eventKep.tanggalSelesai],
  });
  const keps = all.filter((k) => ids(k.fields[F.eventKep.events]).includes(eventId));
  if (keps.length === 0 || !keps.every((k) => str(k.fields[F.eventKep.statusPersetujuan]) === "Disetujui")) throw new RegistrationClosedError();
  for (const k of keps) {
    const end = str(k.fields[F.eventKep.tanggalSelesai]).slice(0, 10);
    if (end) {
      const t = Date.parse(`${end}T00:00:00Z`);
      if (Number.isFinite(t) && now.getTime() > t + (1 + CLOSED_GRACE_DAYS) * DAY_MS) throw new RegistrationClosedError();
    }
  }
  let nama = "";
  try {
    nama = str((await getRecord(T.events, eventId)).fields[F.events.namaAcara]);
  } catch {
    throw new RegistrationClosedError();
  }
  return { eventId, eventKepId: keps[0].id, nama: nama || "KEP" };
}

// ---------------------------------------------------------------------------------------------
// Person (MasterData TeamUmat): find by normalized WA or lowercased email, never overwrite
// ---------------------------------------------------------------------------------------------
const U = F.teamUmat;
const PERSON_FIELDS = [U.namaLengkap, U.namaBaptis, U.email, U.noWhatsapp, U.tanggalLahir, U.alamatTinggal, U.jenisKelamin, U.statusPernikahan, U.paroki, TEAM_UMAT_CREATED];

const createdOf = (r: AtRecord, field: string) => (typeof r.fields[field] === "string" ? (r.fields[field] as string) : "9999");
const byAge = (field: string) => (a: AtRecord, b: AtRecord) => createdOf(a, field).localeCompare(createdOf(b, field)) || a.id.localeCompare(b.id);

const WA_CLEAN = `SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({${U.noWhatsapp}}," ",""),"-",""),"+",""),"(",""),")",""),".","")`;

async function findMatches(input: PesertaInput): Promise<{ byWa: AtRecord[]; byEmail: AtRecord[] }> {
  // The formula only narrows the read; the exact match is re-checked in code with the shared normalization.
  const filterByFormula = `OR(LOWER({${U.email}})=${q(input.email)},FIND(${q(input.wa.slice(-9))},${WA_CLEAN})>0)`;
  const rows = await listRecords(T.teamUmat, { fields: PERSON_FIELDS, filterByFormula });
  const sorted = [...rows].sort(byAge(TEAM_UMAT_CREATED));
  return {
    byWa: sorted.filter((r) => normPhone(r.fields[U.noWhatsapp]) === input.wa),
    byEmail: sorted.filter((r) => normEmail(r.fields[U.email]) === input.email),
  };
}

type PersonCtx = { eventId?: string; actorEmail?: string };
export type ResolvedPerson = { personId: string; created: boolean; ownsEmail: boolean; changed: boolean };

async function resolvePerson(input: PesertaInput, ctx: PersonCtx = {}): Promise<ResolvedPerson> {
  const { byWa, byEmail } = await findMatches(input);
  const common = byWa.find((r) => byEmail.some((e) => e.id === r.id));
  let chosen = common ?? byWa[0] ?? byEmail[0];
  let conflict = false;
  if (!common && byWa[0] && byEmail[0]) {
    // WA and email belong to two different people: never merge. Register against the WA match and flag it.
    conflict = true;
    chosen = byWa[0];
    await logAudit({
      actorEmail: ctx.actorEmail ?? "publik",
      action: "registrasi_konflik_identitas",
      targetId: ctx.eventId ?? "registrasi",
      after: { waPersonId: byWa[0].id, emailPersonId: byEmail[0].id },
    });
  }

  if (chosen) {
    // Only blank, non-identity fields are filled. Existing values and the stored email/WA are never touched.
    const wanted: Record<string, unknown> = {
      [U.namaBaptis]: input.namaBaptis,
      [U.tanggalLahir]: input.tanggalLahir,
      [U.alamatTinggal]: input.alamat,
      [U.jenisKelamin]: input.jenisKelamin,
      [U.statusPernikahan]: input.statusPernikahan,
      [U.paroki]: [input.parokiAsalId],
    };
    const fill: Record<string, unknown> = {};
    if (!conflict) for (const [k, v] of Object.entries(wanted)) if (!blank(v) && blank(chosen.fields[k])) fill[k] = v;
    const patch = pickPublicRegistration(T.teamUmat, fill);
    if (Object.keys(patch).length > 0) await updateRecords(T.teamUmat, [{ id: chosen.id, fields: patch }]);
    return { personId: chosen.id, created: false, ownsEmail: normEmail(chosen.fields[U.email]) === input.email, changed: Object.keys(patch).length > 0 };
  }

  const fields = pickPublicRegistration(T.teamUmat, {
    [U.namaLengkap]: input.namaLengkap,
    ...(input.namaBaptis ? { [U.namaBaptis]: input.namaBaptis } : {}),
    [U.email]: input.email,
    [U.noWhatsapp]: input.wa,
    [U.tanggalLahir]: input.tanggalLahir,
    [U.alamatTinggal]: input.alamat,
    [U.jenisKelamin]: input.jenisKelamin,
    [U.statusPernikahan]: input.statusPernikahan,
    [U.paroki]: [input.parokiAsalId],
  });
  const [made] = await createRecords(T.teamUmat, [fields]);
  // Another instance may have created the same person at the same moment: the oldest row wins (nothing is deleted).
  const again = await findMatches(input);
  const same = new Map([...again.byWa, ...again.byEmail].map((r) => [r.id, r]));
  const winner = [...same.values()].sort(byAge(TEAM_UMAT_CREATED))[0];
  if (winner && winner.id !== made.id && same.has(made.id)) {
    try {
      await logAudit({ actorEmail: ctx.actorEmail ?? "publik", action: "registrasi_person_ganda", targetId: ctx.eventId ?? "registrasi", after: { dipakai: winner.id, yatim: made.id } });
    } catch {
      /* best effort: the orphan row is harmless */
    }
    return { personId: winner.id, created: false, ownsEmail: normEmail(winner.fields[U.email]) === input.email, changed: true };
  }
  return { personId: made.id, created: true, ownsEmail: true, changed: true };
}

export async function findOrCreatePerson(input: PesertaInput, ctx: PersonCtx = {}): Promise<{ personId: string; created: boolean }> {
  const r = await resolvePerson(input, ctx);
  if (r.changed) invalidateKepCache(T.teamUmat);
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
  let eventIdText = "";
  try {
    eventIdText = str((await getRecord(T.events, kep.eventId)).fields[EVENT_ID_FIELD]);
  } catch {
    /* fall back to an unfiltered read */
  }
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
export async function registerPeserta(eventId: string, rawInput: unknown, opts: { actorEmail?: string } = {}): Promise<RegisterResult> {
  const input = PesertaInput.parse(rawInput);
  const kep = await resolveOpenKep(eventId);
  const out = await withLock(kep.eventId, async () => {
    const kepAgain = await resolveOpenKep(eventId); // the status may have changed while we waited for the lock
    const parokis = await listRecords(T.paroki, { fields: [F.paroki.nama] });
    if (!parokis.some((p) => p.id === input.parokiAsalId)) throw new RegistrationInputError("Paroki asal tidak valid");
    const person = await resolvePerson(input, { eventId: kepAgain.eventId, actorEmail: opts.actorEmail });

    const existing = await activeRows(kepAgain, person.personId);
    if (existing.length > 0) return { kep: kepAgain, person, status: "already_registered" as const, id: existing[0].id };

    const fields = pickPublicRegistration(T.pendaftaranEvents, {
      [P.event]: [kepAgain.eventId],
      [P.teamUmat]: [person.personId],
      [P.kategoriKepesertaan]: "Peserta",
      [P.statusPendaftaran]: "Daftar",
      [P.pendukungDoa]: input.pendukungDoa.map((d) => `${d.nama} (${d.kontak})`).join("; "),
      [P.kontakDarurat]: input.kontakDarurat,
      ...(input.riwayatPenyakit ? { [P.riwayatPenyakit]: input.riwayatPenyakit } : {}),
      ...(input.riwayatAlergi ? { [P.riwayatAlergi]: input.riwayatAlergi } : {}),
      ...(input.obatRutin ? { [P.obatRutin]: input.obatRutin } : {}),
    });
    const [made] = await createRecords(T.pendaftaranEvents, [fields]);

    // Re-check: if another instance registered the same person meanwhile, the oldest row wins and ours is
    // marked Batal (never deleted).
    const rows = await activeRows(kepAgain, person.personId);
    const winner = rows[0];
    if (winner && winner.id !== made.id) {
      await updateRecords(T.pendaftaranEvents, [{ id: made.id, fields: pickPublicRegistration(T.pendaftaranEvents, { [P.statusPendaftaran]: "Batal" }) }]);
      return { kep: kepAgain, person, status: "already_registered" as const, id: winner.id };
    }
    return { kep: kepAgain, person, status: "registered" as const, id: made.id };
  });

  invalidateKepCache(T.pendaftaranEvents);
  if (out.person.changed) invalidateKepCache(T.teamUmat);

  let emailTerkirim = false;
  try {
    await sendMail(input.email, "pendaftaran_kep", {
      link: "",
      nama: input.namaLengkap,
      kepNama: out.kep.nama,
      // Only claim "already registered" to an address that provably belongs to the person on file.
      jenis: out.status === "already_registered" && out.person.ownsEmail ? "sudah_terdaftar" : "diterima",
    });
    emailTerkirim = true;
  } catch {
    console.error("Email konfirmasi pendaftaran gagal dikirim");
  }
  return { status: out.status, pendaftaranId: out.id, emailTerkirim };
}
