import "server-only";
import { listRecords, type AtRecord } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { assertKepInScope, scopeFilter } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";

// ---------------------------------------------------------------------------------------------
// Short-lived per-process table cache. Whole-table reads (paginated by the client) are shared by
// concurrent and consecutive requests; in-flight reads are shared (no stampede). Writes call
// invalidateKepCache(table). Returned arrays are shared: treat them as read-only.
// ---------------------------------------------------------------------------------------------
const TABLE_TTL_MS = 45_000;
const PUBLIC_TTL_MS = 10 * 60_000;

type Entry = { at: number; p: Promise<AtRecord[]> };
const tableCache = new Map<string, Entry>();

function cached(table: string, fields: string[]): Promise<AtRecord[]> {
  const key = `${table}|${[...new Set(fields)].sort().join(",")}`;
  const hit = tableCache.get(key);
  if (hit && Date.now() - hit.at < TABLE_TTL_MS) return hit.p;
  const p = listRecords(table, { fields: [...new Set(fields)] });
  const entry = { at: Date.now(), p };
  tableCache.set(key, entry);
  p.catch(() => {
    if (tableCache.get(key) === entry) tableCache.delete(key); // never cache failures
  });
  return p;
}

/** Call after any write to `table` (or without argument to drop everything). */
export function invalidateKepCache(table?: string): void {
  for (const k of [...tableCache.keys()]) if (!table || k.startsWith(`${table}|`)) tableCache.delete(k);
  if (!table || table === T.pendaftaranEvents || table === T.events || table === T.eventKep || table === T.teamUmat) {
    if (pub) pub.at = 0; // keep the value as stale fallback, force refresh on next call
  }
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

function normPhone(v: unknown): string | null {
  let d = str(v).replace(/\D+/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = `62${d.slice(1)}`;
  else if (d.startsWith("8")) d = `62${d}`;
  return d.length >= 9 ? d : null;
}
function normEmail(v: unknown): string | null {
  const e = str(v).toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(e) ? e : null;
}
const parseAngkatan = (name: string): number | null => {
  const m = /angkatan\s*(\d{1,3})/i.exec(name);
  return m ? Number(m[1]) : null;
};
const parishFromName = (name: string) =>
  name.replace(/^\s*KEP\s+PAROKI\s*/i, "").replace(/angkatan\s*\d*/i, "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();

/** Union-find over team members that share a normalized WA number or email. */
function personResolver(people: AtRecord[]) {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const U = F.teamUmat;
  for (const p of people) {
    const keys = [normPhone(p.fields[U.noWhatsapp]), normEmail(p.fields[U.email])];
    if (keys[0]) union(`t:${p.id}`, `p:${keys[0]}`);
    if (keys[1]) union(`t:${p.id}`, `e:${keys[1]}`);
  }
  return (pendaftaran: AtRecord): string => {
    const t = ids(pendaftaran.fields[F.pendaftaranEvents.teamUmat])[0];
    return find(t ? `t:${t}` : `r:${pendaftaran.id}`);
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
type Course = KepEvent & { parokiIds: string[]; memberEventIds: string[] };

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
const PEOPLE_CONTACT = [F.teamUmat.noWhatsapp, F.teamUmat.email];
const STATUS_OK = new Set(["Diajukan", "Disetujui", "Ditolak"]);
const INACTIVE = new Set(["batal", "dobel daftar"]);

type Data = { pend: AtRecord[]; people: AtRecord[]; courses: Course[]; personOf: (p: AtRecord) => string };

async function load(opts: { pendFields?: string[]; peopleFields?: string[] } = {}): Promise<Data> {
  const [events, keps, orgs, paroki, pend, people] = await Promise.all([
    cached(T.events, [F.events.namaAcara, F.events.tanggalAcara, F.events.kelompokAcara]),
    cached(T.eventKep, [F.eventKep.events, F.eventKep.penyelenggara, F.eventKep.statusPersetujuan]),
    cached(T.penyelenggaraKep, [F.penyelenggaraKep.paroki]),
    cached(T.paroki, [F.paroki.nama]),
    cached(T.pendaftaranEvents, [...PEND_CORE, ...(opts.pendFields ?? [])]),
    cached(T.teamUmat, [...PEOPLE_CONTACT, ...(opts.peopleFields ?? [])]),
  ]);
  const personOf = personResolver(people);
  const parokiNama = new Map(paroki.map((p) => [p.id, str(p.fields[F.paroki.nama])]));
  const orgParoki = new Map(orgs.map((o) => [o.id, ids(o.fields[F.penyelenggaraKep.paroki])]));
  const kepsOfEvent = new Map<string, AtRecord[]>();
  for (const k of keps) for (const e of ids(k.fields[F.eventKep.events])) (kepsOfEvent.get(e) ?? kepsOfEvent.set(e, []).get(e)!).push(k);

  // active, distinct people per event
  const peopleOfEvent = new Map<string, Set<string>>();
  for (const p of pend) {
    const f = p.fields;
    if (str(f[F.pendaftaranEvents.kategoriKepesertaan]).toLowerCase() === "panitia") continue;
    if (INACTIVE.has(str(f[F.pendaftaranEvents.statusPendaftaran]).toLowerCase())) continue;
    const who = personOf(p);
    for (const e of ids(f[F.pendaftaranEvents.event])) (peopleOfEvent.get(e) ?? peopleOfEvent.set(e, new Set()).get(e)!).add(who);
  }

  const raw: (Course & { key: string; linked: boolean })[] = [];
  for (const ev of events) {
    const name = str(ev.fields[F.events.namaAcara]);
    if (!strs(ev.fields[F.events.kelompokAcara]).some((g) => g.toUpperCase() === "KEP")) continue;
    const linkedKeps = kepsOfEvent.get(ev.id) ?? [];
    const linked = linkedKeps.length > 0;
    if (!(linked || (COURSE_NAME.test(name) && !NOT_COURSE.test(name)))) continue;

    const parokiIds = [...new Set(linkedKeps.flatMap((k) => ids(k.fields[F.eventKep.penyelenggara])).flatMap((o) => orgParoki.get(o) ?? []))].filter(
      (id) => parokiNama.get(id),
    );
    const status = linkedKeps.map((k) => str(k.fields[F.eventKep.statusPersetujuan])).find((s) => STATUS_OK.has(s));
    const angkatan = parseAngkatan(name);
    const parokiId = parokiIds[0] ?? null;
    raw.push({
      eventId: ev.id,
      eventKepId: linkedKeps[0]?.id ?? null,
      parokiId,
      parokiNama: parokiId ? parokiNama.get(parokiId)! : UNMAPPED,
      angkatan,
      tanggalMulai: str(ev.fields[F.events.tanggalAcara]) || null,
      status: (status as KepEvent["status"]) ?? "Lama",
      pesertaCount: peopleOfEvent.get(ev.id)?.size ?? 0,
      parokiIds,
      memberEventIds: [ev.id],
      linked,
      key: angkatan == null ? `ev:${ev.id}` : `${parokiId ?? `u:${parishFromName(name)}`}|${angkatan}`,
    });
  }

  // legacy duplicates (same paroki + angkatan): keep the entry with the most pendaftar
  const groups = new Map<string, typeof raw>();
  for (const c of raw) (groups.get(c.key) ?? groups.set(c.key, []).get(c.key)!).push(c);
  const courses: Course[] = [...groups.values()].map((g) => {
    const best = [...g].sort(
      (a, b) => b.pesertaCount - a.pesertaCount || Number(b.linked) - Number(a.linked) || a.eventId.localeCompare(b.eventId),
    )[0];
    return {
      ...toKepEvent(best),
      parokiIds: best.parokiIds,
      memberEventIds: g.map((x) => x.eventId),
    };
  });
  courses.sort(
    (a, b) =>
      Number(a.parokiId === null) - Number(b.parokiId === null) ||
      a.parokiNama.localeCompare(b.parokiNama) ||
      (a.angkatan ?? 0) - (b.angkatan ?? 0),
  );
  return { pend, people, courses, personOf };
}

const inParoki = (c: Course, parokiId: string | "ALL") => parokiId === "ALL" || c.parokiIds.includes(parokiId);

/**
 * Course events only (Kelompok Acara KEP and name "KEP PAROKI ..." or linked to an EventKEP), duplicates of
 * paroki+angkatan merged, rows without paroki under "Belum terpetakan" (visible to scope ALL only).
 */
export async function listKepEvents(scope: { parokiId: string | "ALL" }): Promise<KepEvent[]> {
  const { courses } = await load();
  return courses.filter((c) => inParoki(c, scope.parokiId)).map(toKepEvent);
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
  /** Present only for PIC/ADMIN of the owning paroki. Key is absent for SEP. */
  kesehatan?: { riwayatPenyakit: string; riwayatAlergi: string; obatRutin: string; kontakDarurat: string };
};

/**
 * Peserta of the KEP events the session may see (Task 7 guards decide the scope). One row per person per
 * event. Health data only for PIC/ADMIN whose paroki owns the event; never for SEP.
 */
export async function listPesertaView(session: Session, eventKepId?: string): Promise<PesertaView[]> {
  const sc = scopeFilter(session);
  if (eventKepId) await assertKepInScope(session, eventKepId); // 404 for foreign/unknown
  const withHealth = session.role !== "SEP";
  const U = F.teamUmat, P = F.pendaftaranEvents;
  const { pend, people, courses, personOf } = await load({
    pendFields: withHealth ? HEALTH : [],
    peopleFields: [U.namaLengkap, U.namaBaptis, U.jenisKelamin, U.tanggalLahir, U.statusPernikahan],
  });
  const person = new Map(people.map((p) => [p.id, p]));
  const visible = courses.filter(
    (c) => inParoki(c, sc.parokiId) && (!eventKepId || c.eventKepId === eventKepId),
  );
  const out = new Map<string, PesertaView>();
  for (const c of visible) {
    const mayReadHealth = withHealth && !!session.parokiId && c.parokiIds.includes(session.parokiId);
    for (const p of pend) {
      const evs = ids(p.fields[P.event]);
      if (!evs.includes(c.eventId)) continue; // the merged duplicate's rows stay out, like its count
      const tid = ids(p.fields[P.teamUmat])[0] ?? null;
      const t = tid ? person.get(tid) : undefined;
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
      };
      if (mayReadHealth) {
        row.kesehatan = {
          riwayatPenyakit: str(p.fields[P.riwayatPenyakit]),
          riwayatAlergi: str(p.fields[P.riwayatAlergi]),
          obatRutin: str(p.fields[P.obatRutin]),
          kontakDarurat: str(p.fields[P.kontakDarurat]),
        };
      }
      const key = `${c.eventId}|${row.kategori}|${personOf(p)}`;
      const prev = out.get(key);
      // same person twice in one event: prefer the row that has a Keterangan, then the active one
      const rank = (r: PesertaView) => Number(!!r.keterangan) * 2 + Number(!INACTIVE.has(r.statusPendaftaran.toLowerCase()));
      if (!prev || rank(row) > rank(prev)) out.set(key, row);
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------
// Public stats: aggregate only, cached, safe to call anonymously
// ---------------------------------------------------------------------------------------------
export type PublicStats = { paroki: number; angkatan: number; lulusan: number; daftarParoki: { nama: string; angkatan: number }[] };
let pub: { at: number; value?: PublicStats; p?: Promise<PublicStats> } | null = null;

async function computePublicStats(): Promise<PublicStats> {
  const { pend, courses, personOf } = await load();
  // only approved or legacy courses; unmapped ones count towards angkatan/lulusan but not the paroki list
  const open = courses.filter((c) => c.status === "Disetujui" || c.status === "Lama");
  const events = new Set(open.flatMap((c) => c.memberEventIds));
  const lulus = new Set<string>();
  for (const p of pend) {
    if (str(p.fields[F.pendaftaranEvents.kategoriKepesertaan]).toLowerCase() !== "peserta") continue;
    if (str(p.fields[F.pendaftaranEvents.keterangan]).toUpperCase() !== "LULUS") continue;
    if (ids(p.fields[F.pendaftaranEvents.event]).some((e) => events.has(e))) lulus.add(personOf(p));
  }
  const byParoki = new Map<string, { nama: string; angkatan: number }>();
  for (const c of open) {
    if (!c.parokiId) continue;
    const cur = byParoki.get(c.parokiId) ?? { nama: c.parokiNama, angkatan: 0 };
    cur.angkatan = Math.max(cur.angkatan, c.angkatan ?? 0);
    byParoki.set(c.parokiId, cur);
  }
  const daftarParoki = [...byParoki.values()].sort((a, b) => a.nama.localeCompare(b.nama));
  return { paroki: daftarParoki.length, angkatan: open.length, lulusan: lulus.size, daftarParoki };
}

/**
 * Landing-page numbers. Only counts and parish names (no person data). Cached 10 minutes in-process with
 * shared in-flight work, and falls back to the last good value if Airtable fails, so anonymous traffic can
 * never turn into Airtable traffic. Wrap the route with `export const revalidate = 300` as well if desired.
 */
export async function publicStats(): Promise<PublicStats> {
  const now = Date.now();
  if (pub?.value && now - pub.at < PUBLIC_TTL_MS) return pub.value;
  if (pub?.p) return pub.p;
  const stale = pub?.value;
  const p = computePublicStats().then(
    (value) => {
      pub = { at: Date.now(), value };
      return value;
    },
    (err) => {
      pub = stale ? { at: now - PUBLIC_TTL_MS + 30_000, value: stale } : null; // retry in 30 s
      if (stale) return stale;
      throw err;
    },
  );
  pub = { at: pub?.at ?? 0, value: stale, p };
  return p;
}
