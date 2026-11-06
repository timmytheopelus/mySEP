// SINGLE SOURCE OF TRUTH for who may call which API route (spec docs/superpowers/specs/2026-11-06-aplikasi-kep-design.md §6,
// plus the controller rulings recorded in .superpowers/sdd/2026-11-06-aplikasi-kep/progress.md).
//
// tests/security/authz-matrix.test.ts discovers EVERY src/app/api/**/route.ts and fails if a handler exists that has
// no entry here (or an entry has no handler). It calls each handler as SEP, PIC, ADMIN, unauthenticated, and as the
// PIC/ADMIN of ANOTHER parish, and compares the status class with `expected()` below.
// tests/security/csrf.test.ts uses the same list for every mutating route.
//
// Ids refer to the fixture in tests/security/harness.ts.

import type { Role } from "@/lib/auth/session";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type Actor = "SEP" | "PIC" | "ADMIN" | "ANON" | "PIC_OTHER" | "ADMIN_OTHER";
export const ACTORS: Actor[] = ["SEP", "PIC", "ADMIN", "ANON", "PIC_OTHER", "ADMIN_OTHER"];

/** "ok" = authorization passed: the handler answered with anything except 401/403/404 and below 500. */
export type Outcome = "ok" | 401 | 403 | 404 | number;

type Common = {
  /** Path below src/app/api, without /route.ts. */
  route: string;
  method: Method;
  params?: Record<string, string>;
  query?: string;
  /** JSON body (default {}), or "xlsx" for a multipart upload with a one-row workbook. */
  body?: unknown;
  /** Why (spec §6 wording or ruling). */
  rule: string;
};

export type AuthEntry = Common & {
  kind: "auth";
  /** Roles that may call it. Everyone else (logged in) gets 403; without a session 401. */
  roles: Role[];
  /** The record belongs to a parish: PIC/ADMIN of ANOTHER parish get 404 (never 403: no existence oracle). */
  kepScoped: boolean;
};

export type PublicEntry = Common & {
  kind: "public";
  /** Pre-auth flow: a session cookie grants nothing, every actor gets this same status. */
  status: number;
};

export type Entry = AuthEntry | PublicEntry;

const KEP = { id: "recSECKEPA0000001" };
const KEP_SUB = { ...KEP, subEventId: "recSECSUBA0000001" };
const KEP_PID = { ...KEP, pid: "recSECPENDA000001" };
const OP = "op-matrix-0001";

export const MATRIX: Entry[] = [
  // ---- auth flows (public, pre-session) --------------------------------------------------------
  { route: "auth/login", method: "POST", kind: "public", status: 401, body: { email: "nobody@x.id", password: "salah-salah-salah" }, rule: "login: uniform failure for unknown accounts" },
  { route: "auth/logout", method: "POST", kind: "public", status: 200, rule: "logout always clears the cookie" },
  { route: "auth/google/start", method: "GET", kind: "public", status: 302, rule: "redirect to Google" },
  { route: "auth/google/callback", method: "GET", kind: "public", status: 302, rule: "uniform failure redirect" },
  { route: "auth/google/mfa", method: "POST", kind: "public", status: 401, body: { code: "123456" }, rule: "needs the Google pre-auth cookie" },
  { route: "auth/mfa/enroll", method: "POST", kind: "public", status: 401, body: { code: "123456" }, rule: "needs the password pre-auth cookie" },
  { route: "auth/reset/request", method: "POST", kind: "public", status: 200, body: { email: "nobody@x.id" }, rule: "uniform answer, no enumeration" },
  { route: "auth/reset/confirm", method: "POST", kind: "public", status: 400, body: { token: "x", password: "tangga-biru-melompat-77!" }, rule: "invalid one-time link" },
  { route: "daftar/[token]", method: "POST", kind: "public", status: 404, params: { token: "bukan-token" }, rule: "public self-registration: invalid link" },

  // ---- logged-in self service ------------------------------------------------------------------
  // "$TOTP" / "$PASSWORD" are replaced by a valid current code / the actor's password (tests/security/harness.ts).
  { route: "auth/google/link", method: "POST", kind: "auth", roles: ["SEP", "PIC", "ADMIN"], kepScoped: false, body: { code: "$TOTP", password: "$PASSWORD" }, rule: "Hubungkan Google (own account, fresh re-auth)" },
  { route: "auth/mfa/manage", method: "POST", kind: "auth", roles: ["SEP", "PIC", "ADMIN"], kepScoped: false, body: { currentCode: "$TOTP" }, rule: "own MFA (current code when enrolled)" },

  // ---- SEP: accounts, approvals, queue -----------------------------------------------------------
  { route: "akun", method: "GET", kind: "auth", roles: ["SEP"], kepScoped: false, rule: "§6 SEP: kelola akun" },
  { route: "akun", method: "POST", kind: "auth", roles: ["SEP"], kepScoped: false, rule: "§6 SEP: kelola akun" },
  { route: "akun/[id]", method: "PATCH", kind: "auth", roles: ["SEP"], kepScoped: false, params: { id: "recSECPICA0000001" }, body: { action: "bogus" }, rule: "§6 SEP: kelola akun" },
  { route: "kep", method: "GET", kind: "auth", roles: ["SEP"], kepScoped: false, rule: "§6 SEP: antrean persetujuan" },
  { route: "kep/[id]/decision", method: "POST", kind: "auth", roles: ["SEP"], kepScoped: true, params: KEP, body: { keputusan: "Ditolak", catatan: "uji" }, rule: "§6 SEP: setujui/tolak KEP; PIC: tidak bisa menyetujui" },

  // ---- PIC only ------------------------------------------------------------------------------
  { route: "kep", method: "POST", kind: "auth", roles: ["PIC"], kepScoped: false, rule: "§6 PIC: buat KEP; Admin: tidak bisa membuat KEP" },
  { route: "kep/[id]/import/preview", method: "POST", kind: "auth", roles: ["PIC"], kepScoped: true, params: KEP, body: "xlsx", rule: "§6 PIC: kelola peserta (Excel)" },
  { route: "kep/[id]/import/commit", method: "POST", kind: "auth", roles: ["PIC"], kepScoped: true, params: KEP, body: "xlsx", rule: "§6 PIC: kelola peserta (Excel)" },
  { route: "kep/[id]/import/template", method: "GET", kind: "auth", roles: ["PIC"], kepScoped: true, params: KEP, rule: "§6 PIC: kelola peserta (Excel)" },
  { route: "kep/[id]/link-daftar", method: "GET", kind: "auth", roles: ["PIC"], kepScoped: true, params: KEP, rule: "§6 PIC: kelola peserta (link); ruling Task 16b: PIC only" },
  { route: "kep/[id]/link-daftar/rotate", method: "POST", kind: "auth", roles: ["PIC"], kepScoped: true, params: KEP, body: { opId: OP }, rule: "§6 PIC: kelola peserta (link); ruling Task 16b" },
  { route: "kep/[id]/subevent/[sid]/pengajar", method: "POST", kind: "auth", roles: ["PIC", "SEP"], kepScoped: true, params: { ...KEP, sid: KEP_SUB.subEventId }, body: { pengajarIds: ["recSECPEWARTA0001"], opId: OP }, rule: "§6 PIC: ajukan pewarta; SEP: post-approval edit (Task 17); Admin: tidak" },

  // ---- PIC + Admin (absensi, mundur, lulus, manual peserta) ----------------------------------
  { route: "kep/[id]/peserta", method: "POST", kind: "auth", roles: ["PIC", "ADMIN"], kepScoped: true, params: KEP, rule: "§6 PIC: kelola peserta (manual); ADMIN allowed by ruling (OWNER CONFIRMATION pending)" },
  { route: "kep/[id]/absen/[subEventId]", method: "GET", kind: "auth", roles: ["PIC", "ADMIN"], kepScoped: true, params: KEP_SUB, rule: "§6 Admin: absensi; SEP: tidak mengubah absensi" },
  { route: "kep/[id]/absen/[subEventId]/set", method: "POST", kind: "auth", roles: ["PIC", "ADMIN"], kepScoped: true, params: KEP_SUB, body: { pendaftaranId: KEP_PID.pid, hadir: true, opId: OP }, rule: "§6 Admin: absensi; SEP: tidak" },
  { route: "kep/[id]/absen/[subEventId]/semua", method: "POST", kind: "auth", roles: ["PIC", "ADMIN"], kepScoped: true, params: KEP_SUB, body: { opId: OP }, rule: "§6 Admin: absensi; SEP: tidak" },
  { route: "kep/[id]/peserta/[pid]/mundur", method: "POST", kind: "auth", roles: ["PIC", "ADMIN"], kepScoped: true, params: KEP_PID, body: { opId: OP }, rule: "§6 Admin: tandai mundur" },
  { route: "kep/[id]/peserta/[pid]/penetapan", method: "POST", kind: "auth", roles: ["PIC", "ADMIN"], kepScoped: true, params: KEP_PID, body: { hasil: "LULUS", opId: OP }, rule: "§6 Admin: lulus/tidak" },

  // ---- everyone logged in -------------------------------------------------------------------------
  { route: "laporan/[jenis]", method: "GET", kind: "auth", roles: ["SEP", "PIC", "ADMIN"], kepScoped: true, params: { jenis: "kehadiran" }, query: `kep=${KEP.id}`, rule: "§6 PIC: laporan paroki; SEP: unduh laporan; ADMIN by ruling (OWNER CONFIRMATION pending)" },
  { route: "pewarta/[id]", method: "GET", kind: "auth", roles: ["SEP", "PIC", "ADMIN"], kepScoped: false, params: { id: "recSECPEWARTA0001" }, rule: "§8.7 profil pewarta: hanya setelah login" },
  { route: "pewarta/[id]/foto", method: "GET", kind: "auth", roles: ["SEP", "PIC", "ADMIN"], kepScoped: false, params: { id: "recSECPEWARTA0001" }, rule: "§8.6 foto pewarta: hanya setelah login" },
  { route: "pewarta/[id]", method: "PATCH", kind: "auth", roles: ["SEP"], kepScoped: false, params: { id: "recSECPEWARTA0001" }, body: { bioSingkat: "Bio uji" }, rule: "§6 SEP: ubah bio/link YouTube pewarta" },
];

export const OTHER_BASE: Partial<Record<Actor, Role>> = { PIC_OTHER: "PIC", ADMIN_OTHER: "ADMIN" };

export function expected(e: Entry, actor: Actor): Outcome {
  if (e.kind === "public") return e.status;
  if (actor === "ANON") return 401;
  const role: Role = OTHER_BASE[actor] ?? (actor as Role);
  if (!e.roles.includes(role)) return 403;
  if (OTHER_BASE[actor] && e.kepScoped) return 404;
  return "ok";
}

export const isMutating = (m: Method) => m !== "GET";
