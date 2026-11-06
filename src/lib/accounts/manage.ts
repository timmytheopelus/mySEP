import "server-only";
import { F, T, pickAllowedForRole } from "@/lib/airtable/schema";
import { getRecord } from "@/lib/airtable/client";
import {
  ROLE_LABEL,
  emailCount,
  getAccountById as getActiveAccountById,
  hasUsablePassword,
  newUnsetMarker,
  getAccountAnyStatus,
  getAccountByEmail,
  getAccountById,
  insertAccount,
  listAllAccounts,
  normalizeEmail,
  patchAccount,
  savePassword,
  writeAudit,
  type Account,
  type AccountRow,
  type Role,
} from "@/lib/accounts/repo";
import { LINK_TTL_S, linkUrl, signLinkToken, verifyLinkToken } from "@/lib/accounts/links";
import { BreachCheckUnavailableError, hashPassword, isBreachedPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { reauthenticate } from "@/lib/auth/reauth";
import { credentialFingerprint, invalidateAccount, type Session } from "@/lib/auth/session";
import { runInBackground } from "@/lib/background";
import { appBaseUrl, sendMail } from "@/lib/email";
import { HttpError } from "@/lib/http/errors";
import { limitKey, rateLimit } from "@/lib/ratelimit";

const A = F.akunKep;
const ROLES: Role[] = ["SEP", "PIC", "ADMIN"];
const REC_ID = /^rec[A-Za-z0-9]{10,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_EMAIL_LIMIT = 3;
const RESET_WINDOW_S = 15 * 60;

function assertSep(actor: Session): void {
  if (actor.role !== "SEP") throw new HttpError(403);
}

async function loadTarget(id: string): Promise<AccountRow> {
  const t = await getAccountAnyStatus(id);
  if (!t) throw new HttpError(404);
  return t;
}

/** PIC/ADMIN need exactly one existing paroki; SEP never has one. */
async function validateRoleAndParoki(role: unknown, parokiId: unknown): Promise<{ role: Role; parokiId: string | null }> {
  if (typeof role !== "string" || !ROLES.includes(role as Role)) throw new HttpError(422, "Peran tidak valid");
  if (role === "SEP") {
    if (parokiId !== null && parokiId !== undefined && parokiId !== "") throw new HttpError(422, "SEP tidak terikat paroki");
    return { role, parokiId: null };
  }
  if (typeof parokiId !== "string" || !REC_ID.test(parokiId)) throw new HttpError(422, "Paroki wajib diisi untuk PIC dan Admin");
  try {
    await getRecord(T.paroki, parokiId);
  } catch (e) {
    // Only "not found" is the caller's mistake; an outage must not look like bad input.
    if (e instanceof Error && /HTTP (404|422)\b/.test(e.message)) throw new HttpError(422, "Paroki tidak ditemukan");
    throw new HttpError(503);
  }
  return { role: role as Role, parokiId };
}

export type StepUp = { code?: unknown };

/** Fresh TOTP from the ACTING SEP for actions that can mint or unlock privileged access. */
async function requireStepUp(actor: Session, stepUp: StepUp | undefined): Promise<void> {
  const me = await getActiveAccountById(actor.accountId);
  if (!me || !(await reauthenticate(me, { code: stepUp?.code }))) throw new HttpError(403, "Verifikasi ulang gagal");
}

/** Never leave the system without an active SEP (lockout of everyone). Not atomic across parallel calls. */
async function assertNotLastSep(target: AccountRow): Promise<void> {
  if (target.role !== "SEP" || !target.active) return;
  // Only SEPs that can actually sign in count (a password must be set).
  const others = (await listAllAccounts()).filter((a) => a.id !== target.id && a.role === "SEP" && a.active && hasUsablePassword(a));
  if (others.length === 0) throw new HttpError(409, "Tidak dapat menonaktifkan atau menurunkan SEP aktif terakhir");
}

const describe = (a: { role: Role; parokiId: string | null }) => `${a.role}:${a.parokiId ?? "-"}`;
const last4 = (s: string) => `...${s.slice(-4)}`;

async function sendLink(kind: "invite" | "reset", acc: { id: string; email: string; nama: string; passwordHash: string | null }): Promise<boolean> {
  try {
    const token = await signLinkToken(kind, acc.id, acc.passwordHash);
    await sendMail(acc.email, kind, { link: linkUrl(appBaseUrl(), token), nama: acc.nama || undefined });
    return true;
  } catch {
    console.error("sending account email failed"); // no details: the message carries a one-time link
    return false;
  }
}

export type CreateInput = { email: string; nama: string; role: Role; parokiId: string | null };

export async function createAccount(actor: Session, input: CreateInput, stepUp?: StepUp): Promise<Account & { inviteSent: boolean }> {
  assertSep(actor);
  const email = normalizeEmail(String(input?.email ?? ""));
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(422, "Email tidak valid");
  const nama = String(input?.nama ?? "").trim();
  if (!nama || nama.length > 120) throw new HttpError(422, "Nama wajib diisi");
  const { role, parokiId } = await validateRoleAndParoki(input?.role, input?.parokiId);
  // Cheap refusals first, so a 409 never burns the step-up code (codes are single use per TOTP step).
  if ((await emailCount(email)) > 0) throw new HttpError(409, "Email sudah terdaftar");
  if (role === "SEP") await requireStepUp(actor, stepUp);
  const unset = newUnsetMarker();

  // Request-derived fields go through the role allowlist; the password hash is never part of this write.
  const fields = pickAllowedForRole(T.akunKep, actor.role, {
    [A.email]: email,
    [A.nama]: nama,
    [A.peran]: ROLE_LABEL[role],
    [A.paroki]: parokiId ? [parokiId] : [],
    [A.statusAktif]: true,
    [A.hashPassword]: unset, // unusable placeholder: gives this no-password period its own link fingerprint
  });
  const id = await insertAccount(fields);
  if ((await emailCount(email)) > 1) {
    // A concurrent create won the race. Never delete rows: switch ours off and report the conflict.
    await patchAccount(id, { [A.statusAktif]: false });
    throw new HttpError(409, "Email sudah terdaftar");
  }
  await writeAudit({ aksi: "akun_buat", pelaku: actor.email, targetId: id, sesudah: `${email} ${describe({ role, parokiId })}` });
  const acc: Account = {
    id, email, nama, role, parokiId, passwordHash: unset, googleSub: null, mfaSecretEnc: null, failed: 0, lockedUntil: null, lastTotpStep: null,
  };
  return { ...acc, inviteSent: await sendLink("invite", acc) };
}

export async function deactivateAccount(actor: Session, accountId: string): Promise<void> {
  assertSep(actor);
  const t = await loadTarget(accountId);
  if (!t.active) return;
  await assertNotLastSep(t);
  await writeAudit({ aksi: "akun_nonaktif", pelaku: actor.email, targetId: t.id, sebelum: "aktif", sesudah: "nonaktif" });
  await patchAccount(t.id, { [A.statusAktif]: false });
  invalidateAccount(t.id);
}

/** Reactivation clears the password and re-invites, so no token issued before can ever revive. */
export async function reactivateAccount(actor: Session, accountId: string): Promise<void> {
  assertSep(actor);
  const t = await loadTarget(accountId);
  if (t.active) throw new HttpError(409, "Akun sudah aktif");
  await writeAudit({ aksi: "akun_aktif", pelaku: actor.email, targetId: t.id, sebelum: "nonaktif", sesudah: "aktif" });
  const unset = newUnsetMarker();
  await patchAccount(t.id, pickAllowedForRole(T.akunKep, actor.role, {
    [A.statusAktif]: true,
    [A.hashPassword]: unset, // fresh fingerprint: invites/resets from any earlier period are dead
    [A.idGoogle]: null, // the invite must be used first; Google is re-linked afterwards
    [A.gagalLogin]: 0,
    [A.waktuKunci]: null,
  }));
  invalidateAccount(t.id);
  await sendLink("invite", { id: t.id, email: t.email, nama: t.nama, passwordHash: unset });
}

export async function changeAccount(actor: Session, accountId: string, input: { role: Role; parokiId: string | null }, stepUp?: StepUp): Promise<void> {
  assertSep(actor);
  const t = await loadTarget(accountId);
  const next = await validateRoleAndParoki(input?.role, input?.parokiId);
  if (next.role === "SEP" && t.role !== "SEP") await requireStepUp(actor, stepUp);
  if (t.role === "SEP" && next.role !== "SEP") await assertNotLastSep(t);
  await writeAudit({ aksi: "akun_ubah", pelaku: actor.email, targetId: t.id, sebelum: describe(t), sesudah: describe(next) });
  await patchAccount(t.id, pickAllowedForRole(T.akunKep, actor.role, {
    [A.peran]: ROLE_LABEL[next.role],
    [A.paroki]: next.parokiId ? [next.parokiId] : [],
  }));
  invalidateAccount(t.id);
}

export async function clearGoogleBinding(actor: Session, accountId: string, stepUp?: StepUp): Promise<void> {
  assertSep(actor);
  const t = await loadTarget(accountId);
  if (!t.googleSub) throw new HttpError(409, "Tidak ada akun Google yang terhubung");
  await requireStepUp(actor, stepUp);
  await writeAudit({ aksi: "google_unbind", pelaku: actor.email, targetId: t.id, sebelum: last4(t.googleSub), sesudah: "-" });
  await patchAccount(t.id, { [A.idGoogle]: null });
  invalidateAccount(t.id);
}

/** Lost authenticator: SEP clears the TOTP secret; the user enrolls again at next login. */
export async function resetMfa(actor: Session, accountId: string, stepUp?: StepUp): Promise<void> {
  assertSep(actor);
  const t = await loadTarget(accountId);
  if (!t.mfaSecretEnc) throw new HttpError(409, "MFA belum terdaftar");
  await requireStepUp(actor, stepUp);
  await writeAudit({ aksi: "mfa_reset", pelaku: actor.email, targetId: t.id, sebelum: "terdaftar", sesudah: "-" });
  await patchAccount(t.id, { [A.rahasiaMfa]: null, [A.langkahTotpTerakhir]: null });
  invalidateAccount(t.id);
}

// ---- password reset ---------------------------------------------------------------------------

export class LinkError extends Error {
  constructor(public readonly code: "invalid" | "weak" | "breached" | "breach_unavailable", message?: string) {
    super(message ?? "Tautan tidak valid atau sudah kedaluwarsa");
    this.name = "LinkError";
  }
}

/**
 * Always completes the same way and does the same work (lookup, token signing) whether or not the email is
 * registered; delivery runs after the response. A per-email limit silently suppresses further mails.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const e = normalizeEmail(typeof email === "string" ? email : "");
  const lim = await rateLimit(limitKey("reset-email", e), RESET_EMAIL_LIMIT, RESET_WINDOW_S);
  const acc = await getAccountByEmail(e);
  const token = await signLinkToken("reset", acc?.id ?? "recUNKNOWN0000000", acc?.passwordHash ?? null);
  if (!acc || !lim.ok) return;
  runInBackground(async () => {
    try {
      await sendMail(acc.email, "reset", { link: linkUrl(appBaseUrl(), token), nama: acc.nama || undefined });
    } catch {
      console.error("sending reset email failed");
    }
  });
}

/**
 * Accepts a reset link or an invite link (both: "set the password through a single-use emailed link").
 * Single use comes from the binding to the current password hash plus an atomic one-shot claim on the jti.
 */
export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  const claims = await verifyLinkToken(token);
  if (!claims) throw new LinkError("invalid");
  const acc = await getAccountById(claims.accountId); // active only
  if (!acc || credentialFingerprint(acc.passwordHash ?? "") !== claims.fingerprint) throw new LinkError("invalid");

  if (typeof newPassword !== "string") throw new LinkError("weak", "Kata sandi tidak valid.");
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.ok) throw new LinkError("weak", policy.reason);
  try {
    if (await isBreachedPassword(newPassword)) throw new LinkError("breached", "Kata sandi ini pernah bocor di internet. Pilih yang lain.");
  } catch (e) {
    if (e instanceof BreachCheckUnavailableError) throw new LinkError("breach_unavailable", e.message);
    throw e;
  }

  // Only a password that passed every check burns the link.
  const claim = await rateLimit(limitKey("link-used", claims.jti), 1, LINK_TTL_S[claims.kind] + 60);
  if (!claim.ok) throw new LinkError("invalid");
  await savePassword(acc.id, await hashPassword(newPassword));
  invalidateAccount(acc.id);
  try {
    await writeAudit({ aksi: claims.kind === "invite" ? "invite_accept" : "password_reset", pelaku: acc.email, targetId: acc.id });
  } catch {
    console.error("audit write failed after password change");
  }
}
