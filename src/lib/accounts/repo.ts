import "server-only";
import { listRecords, updateRecords, type AtRecord } from "@/lib/airtable/client";
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

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Escape a value for use inside a double-quoted Airtable formula string. */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function isActive(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "aktif");
}

/** Maps a record to an Account; null when it is inactive or has no valid email/role. */
function toAccount(r: AtRecord): Account | null {
  const f = r.fields;
  if (!isActive(f[A.statusAktif])) return null;
  const email = str(f[A.email]);
  const peran = f[A.peran];
  const role = typeof peran === "string" ? ROLE_BY_LABEL[peran.trim().toLowerCase()] : undefined;
  if (!email || !role) return null;
  const paroki = f[A.paroki];
  const step = f[A.langkahTotpTerakhir];
  const failed = f[A.gagalLogin];
  return {
    id: r.id,
    email: normalizeEmail(email),
    nama: str(f[A.nama]) ?? "",
    role,
    parokiId: Array.isArray(paroki) && typeof paroki[0] === "string" ? paroki[0] : null,
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
    filterByFormula: `LOWER({${A.email}}) = ${q(e)}`,
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

export async function bindGoogleSub(id: string, sub: string): Promise<void> {
  await updateRecords(T.akunKep, [{ id, fields: { [A.idGoogle]: sub } }]);
}
