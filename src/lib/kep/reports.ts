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
export const SUPPRESS = "<5";
export type Count = number | typeof SUPPRESS;

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
      loadReportCourses(sc, { hadir: true }),
      readCached(T.subEvent, [S.agenda, S.acara, S.urutan, S.tanggal]),
    ]);
    const rows = courses.filter((c) => c.linkedKepIds.includes(eventKepId)).flatMap((c) => c.rows).filter((r) => r.eventIds.some((e) => eventIds.includes(e)));
    const mundurIds = new Set(rows.filter((r) => r.keterangan === MUNDUR).map((r) => r.pendaftaranId));
    const mundurDay = new Map<string, string>();
    if (mundurIds.size) {
      for (const a of await readCached(T.auditKep, [A.aksi, A.targetId, A.sesudah])) {
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
export type Profil = { kelompokUsia: Record<string, Count>; jenisKelamin: Record<string, Count>; statusPernikahan: Record<string, Count> };
const UNKNOWN = "Tidak diketahui";
const USIA = ["<20", "20-29", "30-39", "40-49", "50-59", "60+", UNKNOWN];

function usiaBucket(lahir: string | null, today: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(lahir ?? "");
  if (!m) return UNKNOWN;
  let age = Number(today.slice(0, 4)) - Number(m[1]);
  if (today.slice(5) < `${m[2]}-${m[3]}`) age -= 1;
  if (age < 0 || age > 120) return UNKNOWN;
  return age < 20 ? "<20" : age < 30 ? "20-29" : age < 40 ? "30-39" : age < 50 ? "40-49" : age < 60 ? "50-59" : "60+";
}

/** Buckets of 1-4 become "<5"; if exactly one was hidden the next smallest is hidden too so it cannot be derived. */
export function suppress(counts: Map<string, number>, order?: string[]): Record<string, Count> {
  const keys = [...counts.keys()].filter((k) => (counts.get(k) ?? 0) > 0);
  if (order) keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  else keys.sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
  const hidden = new Set(keys.filter((k) => counts.get(k)! < 5));
  if (hidden.size === 1) {
    const rest = keys.filter((k) => !hidden.has(k));
    if (rest.length) hidden.add(rest.reduce((m, k) => (counts.get(k)! < counts.get(m)! ? k : m)));
  }
  return Object.fromEntries(keys.map((k) => [k, hidden.has(k) ? SUPPRESS : counts.get(k)!]));
}

export async function profilPeserta(scope: Scope): Promise<Profil> {
  const sc = checkScope(scope);
  return cachedReport("profil", sc, async () => {
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const seen = new Set<string>();
    const usia = new Map<string, number>(), jk = new Map<string, number>(), nikah = new Map<string, number>();
    const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const c of (await loadReportCourses({ parokiId: sc }, { profile: true })).filter(reported)) {
      for (const p of c.peserta) {
        if (seen.has(p.personKey)) continue; // one person, however many angkatan
        seen.add(p.personKey);
        inc(usia, usiaBucket(p.tanggalLahir, today));
        inc(jk, p.jenisKelamin || UNKNOWN);
        inc(nikah, p.statusPernikahan || UNKNOWN);
      }
    }
    return { kelompokUsia: suppress(usia, USIA), jenisKelamin: suppress(jk), statusPernikahan: suppress(nikah) };
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
