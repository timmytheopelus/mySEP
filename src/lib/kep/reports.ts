import "server-only";
import { F, T } from "@/lib/airtable/schema";
import { assertKepInScope, scopeFilter } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { HttpError } from "@/lib/http/errors";
import { cacheGeneration, loadReportCourses, readCached, type ReportCourse } from "@/lib/kep/readModel";
import { neutralize } from "@/lib/security/csv";

type Scope = { parokiId: string | "ALL" };
const REC_ID = /^rec[A-Za-z0-9]{10,}$/;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const day = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : "");
const MUNDUR = "MENGUNDURKAN DIRI";

// ---- small cache: the key always carries the scope (and the read-model generation), never shared across scopes ----
const TTL_MS = 45_000;
const memo = new Map<string, { at: number; p: Promise<unknown> }>();
function cachedReport<R>(name: string, scope: string, fn: () => Promise<R>): Promise<R> {
  const key = `${cacheGeneration()}|${scope}|${name}`;
  const now = Date.now();
  const hit = memo.get(key);
  if (!hit || now - hit.at >= TTL_MS) {
    if (memo.size > 500) memo.clear();
    const p = fn();
    const entry = { at: now, p };
    memo.set(key, entry);
    p.catch(() => {
      if (memo.get(key) === entry) memo.delete(key);
    });
    return p.then((v) => structuredClone(v));
  }
  return (hit.p as Promise<R>).then((v) => structuredClone(v));
}

function checkScope(scope: Scope): string {
  if (!scope || (scope.parokiId !== "ALL" && !REC_ID.test(String(scope.parokiId)))) throw new HttpError(400, "Lingkup laporan tidak valid");
  return scope.parokiId;
}

/** Only approved or legacy courses are reported; queued/rejected ones have no registrants worth counting. */
const reported = (c: ReportCourse) => c.status === "Disetujui" || c.status === "Lama";

export type RekapRow = { paroki: string; angkatan: number; peserta: number; lulus: number; tidakLulus: number; mundur: number };

/** lulus/tidak lulus/mundur come from Keterangan only (never from attendance); mundur is never lulus. */
export async function rekapAngkatan(scope: Scope): Promise<RekapRow[]> {
  const sc = checkScope(scope);
  return cachedReport("rekap", sc, async () => {
    const courses = (await loadReportCourses({ parokiId: sc })).filter(reported);
    return courses
      .map((c) => ({
        paroki: c.parokiNama,
        angkatan: c.angkatan ?? 0,
        peserta: c.peserta.length,
        lulus: c.peserta.filter((p) => p.keterangan === "LULUS").length,
        tidakLulus: c.peserta.filter((p) => p.keterangan === "TIDAK LULUS").length,
        mundur: c.peserta.filter((p) => p.keterangan === MUNDUR).length,
      }))
      .sort((a, b) => a.paroki.localeCompare(b.paroki) || a.angkatan - b.angkatan);
  });
}

export type TrenRow = { tahun: number; angkatan: number; peserta: number; lulus: number };
export async function trenTahunan(scope: Scope): Promise<TrenRow[]> {
  const sc = checkScope(scope);
  return cachedReport("tren", sc, async () => {
    const by = new Map<number, TrenRow>();
    for (const c of (await loadReportCourses({ parokiId: sc })).filter(reported)) {
      const m = /^(\d{4})/.exec(c.tanggalMulai ?? "");
      if (!m) continue; // no date: cannot be placed in a year
      const tahun = Number(m[1]);
      const r = by.get(tahun) ?? { tahun, angkatan: 0, peserta: 0, lulus: 0 };
      r.angkatan += 1;
      r.peserta += c.peserta.length;
      r.lulus += c.peserta.filter((p) => p.keterangan === "LULUS").length;
      by.set(tahun, r);
    }
    return [...by.values()].sort((a, b) => a.tahun - b.tahun);
  });
}

export type KehadiranRow = { agenda: string; tanggal: string; hadir: number; aktif: number };

/**
 * Per pertemuan. aktif = counted peserta except those who withdrew before the meeting. Airtable has no withdrawal
 * date, so the date of the latest 'peserta_mundur' AuditKEP row stands in; without one the peserta counts for no meeting.
 */
export async function kehadiranPerPertemuan(actor: Session, eventKepId: string): Promise<KehadiranRow[]> {
  const { eventKep } = await assertKepInScope(actor, eventKepId); // 404 for foreign/unknown, 403 without paroki
  const sc = scopeFilter(actor);
  const eventIds = ids(eventKep.fields[F.eventKep.events]);
  return cachedReport(`kehadiran:${eventKepId}`, sc.parokiId, async () => {
    const A = F.auditKep, S = F.subEvent;
    const [courses, subs] = await Promise.all([
      loadReportCourses(sc),
      readCached(T.subEvent, [S.agenda, S.acara, S.urutan, S.tanggal]),
    ]);
    const rows = courses.filter((c) => c.linkedKepIds.includes(eventKepId)).flatMap((c) => c.rows).filter((r) => r.eventIds.some((e) => eventIds.includes(e)));
    const mundurIds = new Set(rows.filter((r) => r.keterangan === MUNDUR).map((r) => r.pendaftaranId));
    const mundurDay = new Map<string, string>();
    if (mundurIds.size) {
      const targets = [...mundurIds].filter((id) => REC_ID.test(id));
      const parts = Array.from({ length: Math.ceil(targets.length / 15) }, (_, i) => targets.slice(i * 15, (i + 1) * 15));
      const pages = await Promise.all(
        parts.map((part) =>
          readCached(
            T.auditKep,
            [A.aksi, A.targetId, A.sesudah],
            `AND(OR({${A.aksi}}="peserta_mundur",{${A.aksi}}="peserta_mundur_ulang"),OR(${part.map((id) => `{${A.targetId}}="${id}"`).join(",")}))`,
          ),
        ),
      );
      for (const a of pages.flat()) {
        const aksi = String(a.fields[A.aksi] ?? "");
        const target = String(a.fields[A.targetId] ?? "");
        if ((aksi !== "peserta_mundur" && aksi !== "peserta_mundur_ulang") || !mundurIds.has(target)) continue;
        let t: unknown;
        try {
          t = (JSON.parse(String(a.fields[A.sesudah] ?? "")) as { t?: unknown }).t;
        } catch {
          continue;
        }
        if (typeof t !== "number" || !Number.isFinite(t)) continue;
        const d = new Date(t + 7 * 3600_000).toISOString().slice(0, 10); // WIB calendar day
        if (d > (mundurDay.get(target) ?? "")) mundurDay.set(target, d);
      }
    }
    return subs
      .filter((s) => ids(s.fields[S.acara]).some((e) => eventIds.includes(e)))
      .sort((a, b) => Number(a.fields[S.urutan] ?? 0) - Number(b.fields[S.urutan] ?? 0) || day(a.fields[S.tanggal]).localeCompare(day(b.fields[S.tanggal])) || a.id.localeCompare(b.id))
      .map((s) => {
        const tanggal = day(s.fields[S.tanggal]);
        const aktif = rows.filter((r) => {
          if (r.keterangan !== MUNDUR) return true;
          const d = mundurDay.get(r.pendaftaranId);
          return !!d && !!tanggal && tanggal <= d;
        });
        return {
          agenda: typeof s.fields[S.agenda] === "string" ? (s.fields[S.agenda] as string) : "",
          tanggal,
          hadir: aktif.filter((r) => r.hadirIds.includes(s.id)).length,
          aktif: aktif.length,
        };
      });
  });
}

// ---- participant profile: aggregates with small-number suppression ----
export const SUPPRESS = "<5"; // a true count of 0-4
export const COMPLEMENT = "*"; // hidden only so a "<5" cell cannot be recovered by subtraction
export type Count = number | typeof SUPPRESS | typeof COMPLEMENT;
export type Profil =
  | { suppressed: true }
  | { suppressed: false; kelompokUsia: Record<string, Count>; jenisKelamin: Record<string, Count>; statusPernikahan: Record<string, Count> };
const UNKNOWN = "Tidak diketahui";
export const MIN_PROFIL_N = 10;
const USIA = ["<20", "20-29", "30-39", "40-49", "50-59", "60+", UNKNOWN];
const JK = ["Laki-laki", "Perempuan", UNKNOWN];
const NIKAH = ["Lajang", "Menikah", "Duda", "Janda", "Lainnya", UNKNOWN];

function usiaBucket(lahir: string | null, today: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(lahir ?? "");
  if (!m) return UNKNOWN;
  let age = Number(today.slice(0, 4)) - Number(m[1]);
  if (today.slice(5) < `${m[2]}-${m[3]}`) age -= 1;
  if (age < 0 || age > 120) return UNKNOWN;
  return age < 20 ? "<20" : age < 30 ? "20-29" : age < 40 ? "30-39" : age < 50 ? "40-49" : age < 60 ? "50-59" : "60+";
}
function jkBucket(v: string): string {
  const t = v.trim().toLowerCase();
  if (!t) return UNKNOWN;
  if (/^(l\b|laki|pria)/.test(t)) return "Laki-laki";
  if (/^(p\b|perempuan|wanita)/.test(t)) return "Perempuan";
  return UNKNOWN;
}
function nikahBucket(v: string): string {
  const t = v.trim().toLowerCase();
  if (!t) return UNKNOWN;
  if (/belum|lajang|single/.test(t)) return "Lajang";
  if (/duda/.test(t)) return "Duda";
  if (/janda/.test(t)) return "Janda";
  if (/menikah|kawin|nikah/.test(t)) return "Menikah";
  return "Lainnya";
}

/**
 * Every category of the fixed list is always present. Cells of 0-4 become "<5" (zeros too: presence must not imply >= 1).
 * While anything is hidden, fewer than two cells are hidden or the hidden total is below 5, the smallest visible cell is
 * hidden as "*" (ties: list order), so no hidden cell can be derived by subtraction.
 */
export function suppressDim(counts: Record<string, number>, order: string[]): Record<string, Count> {
  const n = (k: string) => counts[k] ?? 0;
  const out: Record<string, Count> = {};
  const hidden = new Set<string>();
  for (const k of order) if (n(k) < 5) hidden.add(k);
  const real = new Set(hidden);
  while (hidden.size > 0 && (hidden.size < 2 || [...hidden].reduce((a, k) => a + n(k), 0) < 5)) {
    const visible = order.filter((k) => !hidden.has(k));
    if (visible.length === 0) break;
    hidden.add(visible.reduce((m, k) => (n(k) < n(m) ? k : m)));
  }
  for (const k of order) out[k] = hidden.has(k) ? (real.has(k) ? SUPPRESS : COMPLEMENT) : n(k);
  return out;
}

export async function profilPeserta(scope: Scope): Promise<Profil> {
  const sc = checkScope(scope);
  return cachedReport("profil", sc, async (): Promise<Profil> => {
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const seen = new Set<string>();
    const usia: Record<string, number> = {}, jk: Record<string, number> = {}, nikah: Record<string, number> = {};
    const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
    for (const c of (await loadReportCourses({ parokiId: sc })).filter(reported)) {
      for (const p of c.peserta) {
        if (seen.has(p.personKey)) continue; // one person, however many angkatan
        seen.add(p.personKey);
        inc(usia, usiaBucket(p.tanggalLahir, today));
        inc(jk, jkBucket(p.jenisKelamin));
        inc(nikah, nikahBucket(p.statusPernikahan));
      }
    }
    if (seen.size < MIN_PROFIL_N) return { suppressed: true };
    return { suppressed: false, kelompokUsia: suppressDim(usia, USIA), jenisKelamin: suppressDim(jk, JK), statusPernikahan: suppressDim(nikah, NIKAH) };
  });
}

export type KepDash = { disetujui: number; aktif: number; kehadiran: { id: string; nama: string }[] };
/** Approved KEPs, those still running (no end date or end date not past, WIB), and the ones with an attendance report. */
export async function kepDashboard(scope: Scope): Promise<KepDash> {
  const sc = checkScope(scope);
  return cachedReport("kepdash", sc, async () => {
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const ok = (await loadReportCourses({ parokiId: sc })).filter((c) => c.status === "Disetujui" && c.eventKepId);
    return {
      disetujui: ok.length,
      aktif: ok.filter((c) => !c.tanggalSelesai || c.tanggalSelesai >= today).length,
      kehadiran: ok.map((c) => ({ id: c.eventKepId!, nama: c.nama || "KEP" })).sort((a, b) => a.nama.localeCompare(b.nama, "id") || a.id.localeCompare(b.id)),
    };
  });
}

// ---- CSV ----
const cell = (v: unknown): string => {
  const s = typeof v === "number" || typeof v === "boolean" ? String(v) : neutralize(v == null ? "" : String(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** CRLF rows; every header and string cell is neutralised against spreadsheet formulas. BOM is added by the route. */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.map(cell), ...rows.map((r) => cols.map((c) => cell(r[c])))].map((l) => l.join(",")).join("\r\n") + "\r\n";
}
