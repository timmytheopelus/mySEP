import "server-only";
import { type AtRecord } from "@/lib/airtable/client";
import { cachedList, invalidateTable, onInvalidate } from "@/lib/airtable/cache";
import { limitKey, rateLimit, sharedGetJson, sharedSetJson } from "@/lib/ratelimit";
import { EVENT_ID_FIELD, F, T } from "@/lib/airtable/schema";
import { assertKepInScope, parokiAllows, scopeFilter } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";

// Table reads go through the shared per-process cache (src/lib/airtable/cache.ts).
const PUBLIC_TTL_MS = 10 * 60_000;
const FAIL_BACKOFF_MS = 10_000;
const cached = cachedList;
let generation = 0; // any invalidation (report caches, public stats)
onInvalidate(() => {
  generation++;
  if (pub) pub.at = 0; // value kept as stale fallback; next call recomputes
});

/** Call after any write to `table` (or without argument to drop everything). */
export function invalidateKepCache(table?: string): void {
  invalidateTable(table);
}

// ---------------------------------------------------------------------------------------------
// Helpers for dirty legacy values
// ---------------------------------------------------------------------------------------------
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** Single select / text / {name} / first of multi-select, as trimmed string. */
function str(v: unknown): string {
  if (Array.isArray(v)) return v.length ? str(v[0]) : "";
  if (v && typeof v === "object" && "name" in v) return str((v as { name: unknown }).name);
  return typeof v === "string" ? v.trim() : "";
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : [str(v)]).filter(Boolean);

export const UNMAPPED = "Belum terpetakan";
const NOT_COURSE = /pembekalan|bina\s*lanjut/i;
const COURSE_NAME = /^\s*KEP\s+PAROKI/i;

export function normPhone(v: unknown): string | null {
  let d = str(v).replace(/\D+/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = `62${d.slice(1)}`;
  else if (d.startsWith("8")) d = `62${d}`;
  return d.length >= 9 ? d : null;
}
export function normEmail(v: unknown): string | null {
  const e = str(v).toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(e) ? e : null;
}
const parseAngkatan = (name: string): number | null => {
  const m = /angkatan\s*(\d{1,3})/i.exec(name);
  return m ? Number(m[1]) : null;
};
const parishFromName = (name: string) =>
  name.replace(/^\s*KEP\s+PAROKI\s*/i, "").replace(/angkatan\s*\d*/i, "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();

// ---------------------------------------------------------------------------------------------
// Person identity. Two registrations are "the same person" only if they share a usable phone OR email AND
// the names are similar. Compared pairwise against the first (primary) row of a cluster, never transitively.
// A phone/email shared by more than 3 different names is a placeholder/office number and is ignored.
// ---------------------------------------------------------------------------------------------
const TITLES = new Set(["bpk", "bapak", "pak", "ibu", "bu", "sdr", "sdri", "dr", "st", "fr", "rm", "sr"]);
const nameTokens = (v: unknown): string[] =>
  str(v).toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter((t) => t && !TITLES.has(t));

function similarNames(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0 || a[0] !== b[0]) return false;
  if (a.length === 1 || b.length === 1) return true;
  const ra = a.slice(1), rb = b.slice(1);
  return ra.some((x) => rb.some((y) => x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y))));
}

type Identity = { cluster: (rows: AtRecord[]) => AtRecord[][] };
function identity(people: AtRecord[]): Identity {
  const U = F.teamUmat;
  const info = new Map<string, { tokens: string[]; keys: string[] }>();
  const namesOfKey = new Map<string, Set<string>>();
  for (const p of people) {
    const tokens = nameTokens(p.fields[U.namaLengkap]);
    const keys = [normPhone(p.fields[U.noWhatsapp]) && `p:${normPhone(p.fields[U.noWhatsapp])}`, normEmail(p.fields[U.email]) && `e:${normEmail(p.fields[U.email])}`].filter(
      (k): k is string => !!k,
    );
    info.set(p.id, { tokens, keys });
    for (const k of keys) (namesOfKey.get(k) ?? namesOfKey.set(k, new Set()).get(k)!).add(tokens.join(" "));
  }
  const usable = (k: string) => (namesOfKey.get(k)?.size ?? 0) <= 3;
  const tidOf = (r: AtRecord) => ids(r.fields[F.pendaftaranEvents.teamUmat])[0];
  const same = (a: AtRecord, b: AtRecord): boolean => {
    const ta = tidOf(a), tb = tidOf(b);
    if (!ta || !tb) return false;
    if (ta === tb) return true;
    const ia = info.get(ta), ib = info.get(tb);
    if (!ia || !ib) return false;
    return ia.keys.some((k) => usable(k) && ib.keys.includes(k)) && similarNames(ia.tokens, ib.tokens);
  };
  return {
    cluster(rows) {
      const out: AtRecord[][] = [];
      for (const r of [...rows].sort((x, y) => x.id.localeCompare(y.id))) {
        const c = out.find((g) => same(g[0], r));
        if (c) c.push(r);
        else out.push([r]);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------
export type KepEvent = {
  eventId: string;
  eventKepId: string | null;
  parokiId: string | null;
  parokiNama: string;
  angkatan: number | null;
  tanggalMulai: string | null;
  status: "Diajukan" | "Disetujui" | "Ditolak" | "Lama";
  pesertaCount: number;
};
const toKepEvent = (c: KepEvent): KepEvent => ({
  eventId: c.eventId,
  eventKepId: c.eventKepId,
  parokiId: c.parokiId,
  parokiNama: c.parokiNama,
  angkatan: c.angkatan,
  tanggalMulai: c.tanggalMulai,
  status: c.status,
  pesertaCount: c.pesertaCount,
});
type Course = KepEvent & {
  nama: string;
  /** Latest end date over the linked KEPs; null when any of them has none (then it never ends). */
  tanggalSelesai: string | null;
  /** Organizer parish ids per linked EventKEP (a KEP without organizer is an empty list). */
  kepParokis: string[][];
  linkedKepIds: string[];
  memberEventIds: string[];
};

const PEND_CORE = [
  F.pendaftaranEvents.event,
  F.pendaftaranEvents.teamUmat,
  F.pendaftaranEvents.statusPendaftaran,
  F.pendaftaranEvents.kategoriKepesertaan,
  F.pendaftaranEvents.keterangan,
];
const HEALTH = [
  F.pendaftaranEvents.riwayatPenyakit,
  F.pendaftaranEvents.riwayatAlergi,
  F.pendaftaranEvents.obatRutin,
  F.pendaftaranEvents.kontakDarurat,
];
const INACTIVE = new Set(["batal", "dobel daftar"]);
const isInactive = (r: AtRecord) => INACTIVE.has(str(r.fields[F.pendaftaranEvents.statusPendaftaran]).toLowerCase());
const isPanitia = (r: AtRecord) => str(r.fields[F.pendaftaranEvents.kategoriKepesertaan]).toLowerCase() === "panitia";

/** Formula string literal: backslash and double quote escaped. Only ever fed Airtable-sourced constants. */
const fstr = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const EVENT_CHUNK = 15;
const normParish = (s: string) => s.toLowerCase().replace(/\bparoki\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

type Data = { pendByEvent: Map<string, AtRecord[]>; people: AtRecord[]; courses: Course[]; ident: Identity };

async function load(opts: { pendFields?: string[]; peopleFields?: string[] } = {}): Promise<Data> {
  const [events, keps, orgs, paroki, people] = await Promise.all([
    // only Kelompok Acara = KEP (exact select choice; "KEP Exe" etc. excluded again in code)
    cached(T.events, [F.events.namaAcara, F.events.tanggalAcara, F.events.kelompokAcara, EVENT_ID_FIELD], `{${F.events.kelompokAcara}}='KEP'`),
    cached(T.eventKep, [F.eventKep.events, F.eventKep.penyelenggara, F.eventKep.statusPersetujuan, F.eventKep.tanggalSelesai]),
    cached(T.penyelenggaraKep, [F.penyelenggaraKep.paroki]),
    cached(T.paroki, [F.paroki.nama]),
    cached(T.teamUmat, [F.teamUmat.noWhatsapp, F.teamUmat.email, F.teamUmat.namaLengkap, ...(opts.peopleFields ?? [])]),
  ]);
  const parokiNama = new Map(paroki.map((p) => [p.id, str(p.fields[F.paroki.nama])]));
  const orgParoki = new Map(orgs.map((o) => [o.id, ids(o.fields[F.penyelenggaraKep.paroki])]));
  const parokiByName = new Map([...parokiNama].filter(([, n]) => n).map(([id, n]) => [normParish(n), id]));
  const kepsOfEvent = new Map<string, AtRecord[]>();
  for (const k of keps) for (const e of ids(k.fields[F.eventKep.events])) (kepsOfEvent.get(e) ?? kepsOfEvent.set(e, []).get(e)!).push(k);

  type Raw = Course & { key: string; linked: boolean };
  const raw: Raw[] = [];
  const idValues: string[] = [];
  let missingEventId = false;
  for (const ev of events) {
    const name = str(ev.fields[F.events.namaAcara]);
    if (!strs(ev.fields[F.events.kelompokAcara]).some((g) => g.toUpperCase() === "KEP")) continue;
    const linkedKeps = (kepsOfEvent.get(ev.id) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    const linked = linkedKeps.length > 0;
    if (!(linked || (COURSE_NAME.test(name) && !NOT_COURSE.test(name)))) continue;
    const eid = str(ev.fields[EVENT_ID_FIELD]);
    if (eid) idValues.push(eid);
    else missingEventId = true;

    const kepParokis = linkedKeps.map((k) => ids(k.fields[F.eventKep.penyelenggara]).flatMap((o) => orgParoki.get(o) ?? []));
    // display paroki: only when every linked KEP names a (named) paroki in common; otherwise unmapped
    const named = (l: string[]) => l.filter((id) => parokiNama.get(id));
    const common = kepParokis.length ? named(kepParokis[0]).filter((id) => kepParokis.every((l) => l.includes(id))) : [];
    const parokiId = [...new Set(common)].sort()[0] ?? null;
    const sts = linkedKeps.map((k) => str(k.fields[F.eventKep.statusPersetujuan]));
    const status: KepEvent["status"] = !linked
      ? "Lama"
      : sts.includes("Ditolak")
        ? "Ditolak"
        : sts.every((x) => x === "Disetujui")
          ? "Disetujui"
          : "Diajukan"; // linked but empty/unknown status: pending, never public
    const angkatan = parseAngkatan(name);
    const byName = parokiByName.get(parishFromName(name));
    const ends = linkedKeps.map((k) => str(k.fields[F.eventKep.tanggalSelesai]).slice(0, 10));
    raw.push({
      nama: name,
      tanggalSelesai: ends.length && ends.every(Boolean) ? ends.sort().at(-1)! : null,
      eventId: ev.id,
      eventKepId: linkedKeps[0]?.id ?? null,
      parokiId,
      parokiNama: parokiId ? parokiNama.get(parokiId)! : UNMAPPED,
      angkatan,
      tanggalMulai: str(ev.fields[F.events.tanggalAcara]) || null,
      status,
      pesertaCount: 0,
      kepParokis,
      linkedKepIds: linkedKeps.map((k) => k.id),
      memberEventIds: [ev.id],
      linked,
      key: angkatan == null ? `ev:${ev.id}` : `${parokiId ?? (byName ? byName : `u:${parishFromName(name)}`)}|${angkatan}`,
    });
  }

  // Registrations only for the course events: filter by EventID text in the (link) primary values, chunked.
  const pendFields = [...PEND_CORE, ...(opts.pendFields ?? [])];
  const pendRows = missingEventId || idValues.length === 0
    ? idValues.length === 0 && !missingEventId ? [] : await cached(T.pendaftaranEvents, pendFields)
    : (
        await Promise.all(
          Array.from({ length: Math.ceil(idValues.length / EVENT_CHUNK) }, (_, i) => {
            const part = idValues.slice(i * EVENT_CHUNK, (i + 1) * EVENT_CHUNK);
            const f = `OR(${part.map((v) => `FIND(${fstr(v)},ARRAYJOIN({${F.pendaftaranEvents.event}}))>0`).join(",")})`;
            return cached(T.pendaftaranEvents, pendFields, f);
          }),
        )
      ).flat();
  const ident = identity(people);
  const pendByEvent = new Map<string, AtRecord[]>();
  const seen = new Set<string>();
  for (const p of pendRows) {
    if (seen.has(p.id)) continue; // chunks overlap (substring matches)
    seen.add(p.id);
    for (const e of ids(p.fields[F.pendaftaranEvents.event])) (pendByEvent.get(e) ?? pendByEvent.set(e, []).get(e)!).push(p);
  }
  for (const c of raw) c.pesertaCount = ident.cluster((pendByEvent.get(c.eventId) ?? []).filter((r) => !isPanitia(r) && !isInactive(r))).length;

  // legacy duplicates (same paroki + angkatan): keep the entry with the most pendaftar
  const groups = new Map<string, Raw[]>();
  for (const c of raw) (groups.get(c.key) ?? groups.set(c.key, []).get(c.key)!).push(c);
  const courses: Course[] = [...groups.values()].map((g) => {
    const best = [...g].sort(
      (a, b) => b.pesertaCount - a.pesertaCount || Number(b.linked) - Number(a.linked) || a.eventId.localeCompare(b.eventId),
    )[0];
    return {
      ...toKepEvent(best),
      nama: best.nama,
      tanggalSelesai: best.tanggalSelesai,
      kepParokis: best.kepParokis,
      linkedKepIds: [...new Set(g.flatMap((x) => x.linkedKepIds))].sort(),
      memberEventIds: g.map((x) => x.eventId),
    };
  });
  courses.sort(
    (a, b) =>
      Number(a.parokiId === null) - Number(b.parokiId === null) ||
      a.parokiNama.localeCompare(b.parokiNama) ||
      (a.angkatan ?? 0) - (b.angkatan ?? 0),
  );
  return { pendByEvent, people, courses, ident };
}

/** Same rule as the Task 7 guard: ALL scope sees everything; a paroki needs EVERY linked KEP to list it (none organizer-less). */
const courseInScope = (c: Course, parokiId: string | "ALL") =>
  parokiId === "ALL" || (c.kepParokis.length > 0 && c.kepParokis.every((l) => parokiAllows(parokiId, l)));

/**
 * Course events only (Kelompok Acara KEP and name "KEP PAROKI ..." or linked to an EventKEP), duplicates of
 * paroki+angkatan merged, rows without a single clear paroki under "Belum terpetakan" (scope ALL only).
 */
export async function listKepEvents(scope: { parokiId: string | "ALL" }): Promise<KepEvent[]> {
  const { courses } = await load();
  return courses.filter((c) => courseInScope(c, scope.parokiId)).map(toKepEvent);
}

/** Table read through the shared cache (reports). Read-only, shared arrays. */
export const readCached = cached;
/** Bumped by every invalidation: report caches key on it. */
export const cacheGeneration = () => generation;

export type ReportPeserta = {
  pendaftaranId: string;
  /** Internal person key (TeamUmat id, else the registration id); only used to merge, never output. */
  personKey: string;
  eventIds: string[];
  /** Trimmed + uppercased Keterangan. */
  keterangan: string;
  hadirIds: string[];
  jenisKelamin: string;
  tanggalLahir: string | null;
  statusPernikahan: string;
};
export type ReportCourse = {
  eventKepId: string | null;
  nama: string;
  tanggalSelesai: string | null;
  linkedKepIds: string[];
  parokiId: string | null;
  parokiNama: string;
  angkatan: number | null;
  tanggalMulai: string | null;
  status: KepEvent["status"];
  /** One entry per person (probable duplicates merged; Panitia, Batal and Dobel daftar excluded). No names, contact or health data. */
  peserta: ReportPeserta[];
  /** Every countable registration (not merged), as the absensi sheet lists them. */
  rows: ReportPeserta[];
};
const OUTCOME_RANK: Record<string, number> = { LULUS: 3, "TIDAK LULUS": 2, "MENGUNDURKAN DIRI": 1 };

/**
 * Courses inside `scope` (same rule as listKepEvents: a paroki needs EVERY linked KEP to list it, the unmapped
 * bucket is for scope ALL only) with their anonymous peserta rows. Scope is applied here, before any row leaves.
 */
export async function loadReportCourses(scope: { parokiId: string | "ALL" }): Promise<ReportCourse[]> {
  const U = F.teamUmat, P = F.pendaftaranEvents;
  const { pendByEvent, people, courses, ident } = await load({
    // one fixed field set per table: every report shares the same cached reads
    pendFields: [P.pertemuanHadir],
    peopleFields: [U.jenisKelamin, U.tanggalLahir, U.statusPernikahan],
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  const view = (r: AtRecord): ReportPeserta => {
    const t = byId.get(ids(r.fields[P.teamUmat])[0] ?? "");
    return {
      pendaftaranId: r.id,
      personKey: ids(r.fields[P.teamUmat])[0] ?? r.id,
      eventIds: ids(r.fields[P.event]),
      keterangan: str(r.fields[P.keterangan]).toUpperCase(),
      hadirIds: ids(r.fields[P.pertemuanHadir]),
      jenisKelamin: str(t?.fields[U.jenisKelamin]),
      tanggalLahir: str(t?.fields[U.tanggalLahir]) || null,
      statusPernikahan: str(t?.fields[U.statusPernikahan]),
    };
  };
  const out: ReportCourse[] = [];
  for (const c of courses) {
    if (!courseInScope(c, scope.parokiId)) continue;
    const all = [...new Map(c.memberEventIds.flatMap((e) => pendByEvent.get(e) ?? []).map((r) => [r.id, r])).values()].filter(
      (r) => !isInactive(r) && !isPanitia(r),
    );
    const peserta = ident.cluster(all).map((g) => view([...g].sort((a, b) => (OUTCOME_RANK[str(b.fields[P.keterangan]).toUpperCase()] ?? 0) - (OUTCOME_RANK[str(a.fields[P.keterangan]).toUpperCase()] ?? 0))[0]));
    out.push({
      nama: c.nama,
      tanggalSelesai: c.tanggalSelesai,
      eventKepId: c.eventKepId,
      linkedKepIds: c.linkedKepIds,
      parokiId: c.parokiId,
      parokiNama: c.parokiNama,
      angkatan: c.angkatan,
      tanggalMulai: c.tanggalMulai,
      status: c.status,
      peserta,
      rows: all.map(view),
    });
  }
  return out;
}

export type PesertaView = {
  pendaftaranId: string;
  eventId: string;
  teamUmatId: string | null;
  namaLengkap: string;
  namaBaptis: string;
  jenisKelamin: string;
  tanggalLahir: string | null;
  statusPernikahan: string;
  statusPendaftaran: string;
  kategori: string;
  keterangan: string;
  /** Same person probably registered twice in this event (shared phone/email and similar name). Never dropped. */
  kemungkinanGanda: boolean;
  /** Present only for PIC/ADMIN whose paroki owns the event. Key is absent for SEP. */
  kesehatan?: { riwayatPenyakit: string; riwayatAlergi: string; obatRutin: string; kontakDarurat: string };
};

/**
 * Peserta of the KEP events the session may see (Task 7 guards decide the scope). Every registration is
 * listed; probable duplicates are flagged. Health data only for PIC/ADMIN of the owning paroki; never SEP.
 */
export async function listPesertaView(session: Session, eventKepId?: string): Promise<PesertaView[]> {
  const sc = scopeFilter(session);
  if (eventKepId) await assertKepInScope(session, eventKepId); // 404 for foreign/unknown
  const withHealth = session.role !== "SEP";
  const U = F.teamUmat, P = F.pendaftaranEvents;
  const { pendByEvent, people, courses, ident } = await load({
    pendFields: withHealth ? HEALTH : [],
    peopleFields: [U.namaBaptis, U.jenisKelamin, U.tanggalLahir, U.statusPernikahan],
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  const out: PesertaView[] = [];
  for (const c of courses) {
    if (!courseInScope(c, sc.parokiId)) continue;
    if (eventKepId && !c.linkedKepIds.includes(eventKepId)) continue;
    const mayReadHealth = withHealth && !!session.parokiId && courseInScope(c, session.parokiId);
    const rows = pendByEvent.get(c.eventId) ?? [];
    const dupIds = new Set<string>();
    for (const kategori of new Set(rows.map((r) => str(r.fields[P.kategoriKepesertaan])))) {
      for (const g of ident.cluster(rows.filter((r) => str(r.fields[P.kategoriKepesertaan]) === kategori)))
        if (g.length > 1) g.forEach((r) => dupIds.add(r.id));
    }
    for (const p of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
      const tid = ids(p.fields[P.teamUmat])[0] ?? null;
      const t = tid ? byId.get(tid) : undefined;
      const row: PesertaView = {
        pendaftaranId: p.id,
        eventId: c.eventId,
        teamUmatId: tid,
        namaLengkap: str(t?.fields[U.namaLengkap]),
        namaBaptis: str(t?.fields[U.namaBaptis]),
        jenisKelamin: str(t?.fields[U.jenisKelamin]),
        tanggalLahir: str(t?.fields[U.tanggalLahir]) || null,
        statusPernikahan: str(t?.fields[U.statusPernikahan]),
        statusPendaftaran: str(p.fields[P.statusPendaftaran]),
        kategori: str(p.fields[P.kategoriKepesertaan]),
        keterangan: str(p.fields[P.keterangan]),
        kemungkinanGanda: dupIds.has(p.id),
      };
      if (mayReadHealth) {
        row.kesehatan = {
          riwayatPenyakit: str(p.fields[P.riwayatPenyakit]),
          riwayatAlergi: str(p.fields[P.riwayatAlergi]),
          obatRutin: str(p.fields[P.obatRutin]),
          kontakDarurat: str(p.fields[P.kontakDarurat]),
        };
      }
      out.push(row);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public stats: aggregate only, cached, safe to call anonymously
// ---------------------------------------------------------------------------------------------
export type PublicStats = {
  paroki: number;
  angkatan: number;
  lulusan: number;
  /** angkatan = latest angkatan number of that parish (an ordinal label, shown as is). No per-parish participant counts are exposed. */
  daftarParoki: { nama: string; angkatan: number }[];
};
let pub: { at: number; value?: PublicStats; okAt?: number; p?: Promise<PublicStats>; failedAt?: number; err?: unknown } | null = null;

async function computePublicStats(): Promise<PublicStats> {
  const { pendByEvent, courses, ident } = await load();
  // only approved or legacy (no EventKEP) courses; unmapped ones count towards angkatan/lulusan but not the paroki list
  const open = courses.filter((c) => c.status === "Disetujui" || c.status === "Lama");
  let lulusan = 0;
  for (const c of open) {
    const rows = [...new Map(c.memberEventIds.flatMap((e) => pendByEvent.get(e) ?? []).map((r) => [r.id, r])).values()].filter(
      (r) =>
        !isInactive(r) &&
        str(r.fields[F.pendaftaranEvents.kategoriKepesertaan]).toLowerCase() === "peserta" &&
        str(r.fields[F.pendaftaranEvents.keterangan]).toUpperCase() === "LULUS",
    );
    lulusan += ident.cluster(rows).length; // dedupe inside one course only
  }
  const byParoki = new Map<string, { nama: string; angkatan: number }>();
  for (const c of open) {
    if (!c.parokiId) continue;
    const cur = byParoki.get(c.parokiId) ?? { nama: c.parokiNama, angkatan: 0 };
    cur.angkatan = Math.max(cur.angkatan, c.angkatan ?? 0);
    byParoki.set(c.parokiId, cur);
  }
  const daftarParoki = [...byParoki.values()]
    .sort((a, b) => a.nama.localeCompare(b.nama))
    .map((v) => ({ nama: v.nama, angkatan: v.angkatan }));
  return { paroki: daftarParoki.length, angkatan: open.length, lulusan, daftarParoki };
}

const PUBLIC_STALE_MAX_MS = 24 * 3600_000;
const SHARED_KEY = "kep:public-stats:v1";
type Shared = { at: number; value: PublicStats };

/**
 * Landing-page numbers. Only counts and parish names (no person data). Fresh for 10 minutes in-process, one
 * shared in-flight compute, last good value (at most 24 h old) on failure, short failure backoff; an invalidation
 * during a compute makes that result stale-only (never "fresh"). Blocking: for internal callers and tests; the
 * public page uses publicStatsForPage (never blocks on Airtable).
 */
export async function publicStats(): Promise<PublicStats> {
  const now = Date.now();
  if (pub?.value && now - pub.at < PUBLIC_TTL_MS) return pub.value;
  if (pub?.p) return pub.p;
  const usable = (v?: { at: number; value?: PublicStats; okAt?: number }) => (v?.value && now - (v.okAt ?? 0) < PUBLIC_STALE_MAX_MS ? v.value : undefined);
  if (pub?.failedAt !== undefined && now - pub.failedAt < FAIL_BACKOFF_MS) {
    const v = usable(pub);
    if (v) return v;
    throw pub.err;
  }
  const gen = generation;
  const prev = pub;
  const p = computePublicStats().then(
    (value) => {
      const t = Date.now();
      pub = { at: gen === generation ? t : 0, value, okAt: t };
      void sharedSetJson(SHARED_KEY, { at: t, value } satisfies Shared, PUBLIC_STALE_MAX_MS / 1000);
      return value;
    },
    (err) => {
      const stale = usable(prev ?? undefined);
      pub = { at: 0, value: stale, okAt: stale ? prev?.okAt : undefined, failedAt: Date.now(), err };
      if (stale) return stale;
      throw err;
    },
  );
  pub = { at: 0, value: prev?.value, okAt: prev?.okAt, p };
  return p;
}

/** Refresh triggers per client IP (cold instances fanned out by one client cannot drain the Airtable budget). */
export const PUBLIC_REFRESH_LIMIT = 5;
export const PUBLIC_REFRESH_WINDOW_S = 600;

/**
 * For the public landing page (unauthenticated): NEVER waits for Airtable. Order: in-process value (fresh 10 min)
 * -> shared Upstash value (any instance's last compute, up to 24 h) -> null (the page shows its static fallback).
 * When the value is missing or older than 10 minutes a refresh starts in the background (single flight per
 * instance, failure backoff), but only if this IP is within PUBLIC_REFRESH_LIMIT per 10 minutes.
 */
export async function publicStatsForPage(ip: string, opts: { background?: (fn: () => Promise<unknown>) => void } = {}): Promise<PublicStats | null> {
  const now = Date.now();
  if (pub?.value && now - pub.at < PUBLIC_TTL_MS) return pub.value;
  let value = pub?.value && now - (pub.okAt ?? 0) < PUBLIC_STALE_MAX_MS ? pub.value : null;
  let freshEnough = false;
  if (!value || !pub?.okAt || now - pub.okAt >= PUBLIC_TTL_MS) {
    const shared = await sharedGetJson<Shared>(SHARED_KEY);
    if (shared?.value && typeof shared.at === "number" && now - shared.at < PUBLIC_STALE_MAX_MS && (!pub?.okAt || shared.at > pub.okAt)) {
      value = shared.value;
      freshEnough = now - shared.at < PUBLIC_TTL_MS;
      if (!pub?.p) pub = { at: freshEnough ? shared.at : 0, value: shared.value, okAt: shared.at, failedAt: pub?.failedAt, err: pub?.err };
    }
  }
  if (!freshEnough && !pub?.p && !(pub?.failedAt !== undefined && now - pub.failedAt < FAIL_BACKOFF_MS)) {
    const lim = await rateLimit(limitKey("public-stats-refresh", ip), PUBLIC_REFRESH_LIMIT, PUBLIC_REFRESH_WINDOW_S);
    if (lim.ok) {
      const run = () => publicStats().catch(() => undefined);
      if (opts.background) opts.background(run);
      else void run();
    }
  }
  return value;
}

/** Tests: forget the in-process public stats (simulates a cold instance). */
export function resetPublicStatsMemory(): void {
  pub = null;
}
