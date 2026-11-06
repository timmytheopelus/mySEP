import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { createRecords, listRecords, updateRecords, type AtRecord } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";

export type Role = "SEP" | "PIC" | "ADMIN";

export type Account = {
  id: string;
  email: string;
  nama: string;
  role: Role;
  parokiId: string | null;
  passwordHash: string | null;
  /** Bound Google subject (ID Google); null until the first Google login. */
  googleSub: string | null;
  /** AES-GCM blob (see encryptSecret); null when MFA is not enrolled. */
  mfaSecretEnc: string | null;
  failed: number;
  lockedUntil: string | null;
  /** Last accepted TOTP time step; null when none yet (never -1). */
  lastTotpStep: number | null;
};

const A = F.akunKep;
const FIELDS = Object.values(A);

const ROLE_BY_LABEL: Record<string, Role> = {
  sep: "SEP",
  pic: "PIC",
  "pic paroki": "PIC",
  admin: "ADMIN",
  "admin paroki": "ADMIN",
};

/** Random unusable placeholder stored while an account has no password: each no-password period gets its own
 * hash fingerprint, so one-time links from an earlier period can never be valid again. Never verifies. */
export const UNSET_PREFIX = "unset:";
export const newUnsetMarker = () => UNSET_PREFIX + randomBytes(32).toString("base64url");
export const hasUsablePassword = (a: { passwordHash: string | null }) => !!a.passwordHash && !a.passwordHash.startsWith(UNSET_PREFIX);

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Escape a value for use inside a double-quoted Airtable formula string. */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function isActive(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "aktif");
}

export type AccountRow = Account & { active: boolean };

/** Maps a record to an Account; null when it is inactive or has no valid email/role. */
function toAccount(r: AtRecord): Account | null {
  const a = parseAccount(r);
  return a && a.active ? a : null;
}

/** Like toAccount but keeps inactive accounts (SEP administration only). */
function parseAccount(r: AtRecord): AccountRow | null {
  const f = r.fields;
  const email = str(f[A.email]);
  const peran = f[A.peran];
  const role = typeof peran === "string" ? ROLE_BY_LABEL[peran.trim().toLowerCase()] : undefined;
  if (!email || !role) return null;
  const paroki = f[A.paroki];
  const step = f[A.langkahTotpTerakhir];
  const failed = f[A.gagalLogin];
  return {
    active: isActive(f[A.statusAktif]),
    id: r.id,
    email: normalizeEmail(email),
    nama: str(f[A.nama]) ?? "",
    role,
    // Exactly one link, else null (misconfigured: guards answer 403; never pick "the first").
    parokiId: Array.isArray(paroki) && paroki.length === 1 && typeof paroki[0] === "string" ? paroki[0] : null,
    passwordHash: str(f[A.hashPassword]),
    googleSub: str(f[A.idGoogle]),
    mfaSecretEnc: str(f[A.rahasiaMfa]),
    failed: typeof failed === "number" ? failed : 0,
    lockedUntil: str(f[A.waktuKunci]),
    lastTotpStep: typeof step === "number" && Number.isInteger(step) && step >= 0 ? step : null,
  };
}

/** Lower-cased lookup, active accounts only. */
export async function getAccountByEmail(email: string): Promise<Account | null> {
  const e = normalizeEmail(email);
  if (!e || e.length > 254) return null;
  const recs = await listRecords(T.akunKep, {
    fields: FIELDS,
    filterByFormula: `LOWER(TRIM({${A.email}})) = ${q(e)}`,
    maxRecords: 2,
  });
  // Defence in depth: never trust the formula alone.
  for (const r of recs) {
    const a = toAccount(r);
    if (a && a.email === e) return a;
  }
  return null;
}

/** Active account by record id (session revocation check). */
export async function getAccountById(id: string): Promise<Account | null> {
  if (!/^rec[A-Za-z0-9]{10,}$/.test(id)) return null;
  const recs = await listRecords(T.akunKep, {
    fields: FIELDS,
    filterByFormula: `RECORD_ID() = ${q(id)}`,
    maxRecords: 1,
  });
  const r = recs.find((x) => x.id === id);
  return r ? toAccount(r) : null;
}

export async function recordFailure(id: string, s: { failed: number; lockedUntil: string | null }): Promise<void> {
  await updateRecords(T.akunKep, [{ id, fields: { [A.gagalLogin]: s.failed, [A.waktuKunci]: s.lockedUntil } }]);
}

/** Full login success: resets the failure count, stamps login time and the used TOTP step (omitted when none). */
export async function recordSuccess(id: string, now: Date, totpStep: number | null): Promise<void> {
  await updateRecords(T.akunKep, [
    {
      id,
      fields: {
        [A.gagalLogin]: 0,
        [A.waktuKunci]: null,
        [A.loginTerakhir]: now.toISOString(),
        ...(totpStep !== null ? { [A.langkahTotpTerakhir]: totpStep } : {}),
      },
    },
  ]);
}

export async function saveMfaEnrollment(id: string, secretEnc: string, totpStep: number): Promise<void> {
  await updateRecords(T.akunKep, [{ id, fields: { [A.rahasiaMfa]: secretEnc, [A.langkahTotpTerakhir]: totpStep } }]);
}

export const mfaRequired = (role: Role) => role === "SEP" || role === "PIC";

/**
 * First Google login: writes the sub, appends an AuditKEP row (aksi google_bind; only the last 4 chars of
 * the sub), then re-reads the account and returns the sub that is actually stored so the caller can
 * detect a lost race. Any write error propagates (the login fails).
 */
export async function bindGoogleSub(id: string, sub: string, email: string): Promise<string | null> {
  await updateRecords(T.akunKep, [{ id, fields: { [A.idGoogle]: sub } }]);
  const AU = F.auditKep;
  await createRecords(T.auditKep, [
    { [AU.aksi]: "google_bind", [AU.pelaku]: email, [AU.targetId]: id, [AU.sesudah]: sub.slice(-4) },
  ]);
  return (await getAccountById(id))?.googleSub ?? null;
}

// ---- SEP administration (Task 8) -------------------------------------------------------------

export const ROLE_LABEL: Record<Role, string> = { SEP: "SEP", PIC: "PIC Paroki", ADMIN: "Admin Paroki" };

/** Every account, active or not. */
export async function listAllAccounts(): Promise<AccountRow[]> {
  const recs = await listRecords(T.akunKep, { fields: FIELDS });
  return recs.map(parseAccount).filter((a): a is AccountRow => a !== null);
}

/** Account by record id regardless of status; null when unknown or malformed. */
export async function getAccountAnyStatus(id: string): Promise<AccountRow | null> {
  if (!/^rec[A-Za-z0-9]{10,}$/.test(id)) return null;
  const recs = await listRecords(T.akunKep, { fields: FIELDS, filterByFormula: `RECORD_ID() = ${q(id)}`, maxRecords: 1 });
  const r = recs.find((x) => x.id === id);
  return r ? parseAccount(r) : null;
}

/** Number of accounts (active or not) using this email. */
export async function emailCount(email: string): Promise<number> {
  const e = normalizeEmail(email);
  const recs = await listRecords(T.akunKep, { fields: [A.email], filterByFormula: `LOWER(TRIM({${A.email}})) = ${q(e)}`, maxRecords: 5 });
  return recs.filter((r) => typeof r.fields[A.email] === "string" && normalizeEmail(r.fields[A.email] as string) === e).length;
}

export async function insertAccount(fields: Record<string, unknown>): Promise<string> {
  const [rec] = await createRecords(T.akunKep, [fields]);
  return rec.id;
}

export async function patchAccount(id: string, fields: Record<string, unknown>): Promise<void> {
  await updateRecords(T.akunKep, [{ id, fields }]);
}

/** Sets a new password hash and clears the failure counter/lock. */
export async function savePassword(id: string, hash: string): Promise<void> {
  await patchAccount(id, { [A.hashPassword]: hash, [A.gagalLogin]: 0, [A.waktuKunci]: null });
}

/** Persist only the used TOTP step (re-authentication of a logged-in user). */
export async function saveTotpStep(id: string, step: number): Promise<void> {
  await patchAccount(id, { [A.langkahTotpTerakhir]: step });
}

/** Append-only audit row. Throws on failure so callers can refuse to act unaudited. */
export async function writeAudit(row: { aksi: string; pelaku: string; targetId: string; sebelum?: string; sesudah?: string }): Promise<void> {
  const AU = F.auditKep;
  await createRecords(T.auditKep, [
    {
      [AU.aksi]: row.aksi,
      [AU.pelaku]: row.pelaku,
      [AU.targetId]: row.targetId,
      ...(row.sebelum !== undefined ? { [AU.sebelum]: row.sebelum } : {}),
      ...(row.sesudah !== undefined ? { [AU.sesudah]: row.sesudah } : {}),
      [AU.opId]: randomUUID(),
    },
  ]);
}
