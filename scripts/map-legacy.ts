/**
 * One-time legacy data mapping (Task 18). DEFAULT IS DRY-RUN: reads, plans, writes reports/legacy-mapping.csv.
 *
 *   pnpm map-legacy                              dry-run against the live base (needs AIRTABLE_TOKEN + AIRTABLE_BASE_ID)
 *   pnpm map-legacy --from-snapshot <dir>        dry-run from exported JSON files (see task-18-report.md)
 *   pnpm map-legacy --apply --confirm=YA         write (live only; needs explicit approval from the owner)
 *
 * Apply does ONLY: (a) copy BabKEP -> SubEvent (idempotency key "legacy:<BabKEP id>" in SubEvent.Keterangan),
 * (b) fill EventKEP.Events (paroki+angkatan -> Events, only if exactly one candidate),
 * (c) fill Pengelenggara KEP.Paroki (exact normalised name match). Only empty fields / new rows; no deletes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { F, T } from "@/lib/airtable/schema";
import { toCsv } from "@/lib/kep/reports";

export type AtRec = { id: string; fields: Record<string, unknown> };
export interface DataSource {
  kind: "live" | "snapshot";
  read(table: string): Promise<AtRec[]>;
  create(table: string, rows: Record<string, unknown>[]): Promise<AtRec[]>;
  update(table: string, rows: { id: string; fields: Record<string, unknown> }[], extra?: Set<string>): Promise<AtRec[]>;
}

export type Jenis = "cocok" | "tidak cocok" | "duplikat" | "rencana tulis";
export type Row = { jenis: Jenis; tabel: string; ids: string; keterangan: string; rencana: string };
type SubCreate = { legacyId: string; fields: Record<string, unknown> };
type Upd = { id: string; fields: Record<string, unknown> };
export type Plan = { hash: string; rows: Row[]; subEvents: SubCreate[]; eventKepUpdates: Upd[]; penyelenggaraUpdates: Upd[] };

// ---- table -> files / fields (exact snapshot format is documented in task-18-report.md) ----
const SOURCES: { table: string; file: string; fields: string[] }[] = [
  { table: T.babKep, file: "babkep.json", fields: [F.babKep.bab, F.babKep.tanggal, F.babKep.pengajar, F.babKep.eventKep] },
  { table: T.eventKep, file: "eventkep.json", fields: [F.eventKep.events, F.eventKep.penyelenggara, F.eventKep.angkatan] },
  { table: T.penyelenggaraKep, file: "pengelenggara.json", fields: [F.penyelenggaraKep.paroki, F.penyelenggaraKep.penyelenggara] },
  { table: T.paroki, file: "paroki.json", fields: [F.paroki.nama] },
  { table: T.events, file: "events.json", fields: [F.events.namaAcara, F.events.kelompokAcara] },
  { table: T.subEvent, file: "subevent.json", fields: [F.subEvent.acara, F.subEvent.urutan, F.subEvent.keterangan] },
];

const LEGACY = /legacy:(rec\w+)/g;
// Teaching order, used only as a tie-break after the date. Unknown names sort last.
const BAB_ORDER = [
  "Misa Pembukaan", "Iman Katolik", "Bab 1 Orientasi Evangelisasi", "Bab 2 Evangelisasi Pendalaman", "Bab 3 Perkembangan Iman",
  "Bab 4 Kerajaan Allah & Keselamatan", "Bab 5 Berteman dengan Sesama", "Bab 6 Kesaksian Iman", "Bab 7 Kisah Kristus",
  "Bab 8 Tawaran Kepada Pertobatan", "Bab 9 Ajakan Bergabung ke dalam Komunitas", "Bab 10 Praktek Evangelisasi",
  "Evangelii Nuntiandi", "Maria Bintang Evangelisasi", "Evaluasi Kunjungan rumah", "Pengantar Retus", "Retreat Pengutusan", "Peneguhan",
];

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : "")).filter(Boolean) : str(v) ? [str(v)] : []);
const empty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
const normName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(paroki|kep)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const parseAngkatan = (name: string): number | null => {
  const m = /angkatan\s*(\d{1,3})/i.exec(name);
  return m ? Number(m[1]) : null;
};
const parishOfEvent = (name: string) => normName(name.replace(/angkatan\s*\d*/i, ""));
const row = (jenis: Jenis, tabel: string, idl: string[], keterangan: string, rencana = ""): Row => ({ jenis, tabel, ids: idl.join(" "), keterangan, rencana });

export function buildPlan(d: Record<string, AtRec[]>): Plan {
  const rows: Row[] = [];
  const paroki = d[T.paroki] ?? [];
  const orgs = d[T.penyelenggaraKep] ?? [];
  const keps = d[T.eventKep] ?? [];
  const events = d[T.events] ?? [];
  const babs = d[T.babKep] ?? [];
  const subs = d[T.subEvent] ?? [];
  const parokiName = new Map(paroki.map((p) => [p.id, str(p.fields[F.paroki.nama])]));

  // ---- (c) Pengelenggara KEP.Paroki ----
  const byNorm = new Map<string, string[]>();
  for (const p of paroki) {
    const n = normName(str(p.fields[F.paroki.nama]));
    if (n) (byNorm.get(n) ?? byNorm.set(n, []).get(n)!).push(p.id);
  }
  const penyelenggaraUpdates: Upd[] = [];
  const orgParokiNorm = new Map<string, string>();
  const orgSrc = new Map<string, string>();
  for (const o of orgs) {
    const name = str(o.fields[F.penyelenggaraKep.penyelenggara]);
    const linked = ids(o.fields[F.penyelenggaraKep.paroki]);
    if (linked.length) {
      orgParokiNorm.set(o.id, normName(parokiName.get(linked[0]) ?? name));
      orgSrc.set(o.id, "Paroki tertaut");
      rows.push(row("cocok", "Pengelenggara KEP", [o.id], `Paroki sudah terisi (${linked.map((l) => parokiName.get(l) ?? l).join(", ")}); tidak diubah`));
      continue;
    }
    const n = normName(name);
    orgParokiNorm.set(o.id, n);
    orgSrc.set(o.id, "nama penyelenggara");
    const hit = n ? (byNorm.get(n) ?? []) : [];
    if (!name) rows.push(row("tidak cocok", "Pengelenggara KEP", [o.id], "Nama penyelenggara kosong"));
    else if (hit.length === 0) rows.push(row("tidak cocok", "Pengelenggara KEP", [o.id], `${name} (nama penyelenggara) tidak sama persis dengan paroki mana pun; tidak ditulis`));
    else if (hit.length > 1) rows.push(row("duplikat", "Pengelenggara KEP", [o.id, ...hit], `Nama "${name}" cocok dengan ${hit.length} paroki; tidak ditulis`));
    else {
      penyelenggaraUpdates.push({ id: o.id, fields: { [F.penyelenggaraKep.paroki]: [hit[0]] } });
      rows.push(row("rencana tulis", "Pengelenggara KEP", [o.id, hit[0]], `"${name}" = paroki "${parokiName.get(hit[0])}"`, "isi field Paroki"));
    }
  }

  // ---- Events: duplicate groups (same paroki + angkatan) ----
  type Ev = { id: string; parish: string; angkatan: number };
  const courseEvents: Ev[] = [];
  for (const e of events) {
    if (!strs(e.fields[F.events.kelompokAcara]).some((g) => g.toUpperCase() === "KEP")) continue;
    const name = str(e.fields[F.events.namaAcara]);
    const a = parseAngkatan(name);
    if (a != null) courseEvents.push({ id: e.id, parish: parishOfEvent(name), angkatan: a });
    else rows.push(row("tidak cocok", "Events", [e.id], "angkatan tak terbaca dari nama acara KEP; tidak dipakai untuk pencocokan"));
  }
  const evGroups = new Map<string, Ev[]>();
  for (const e of courseEvents) {
    const k = `${e.parish}|${e.angkatan}`;
    (evGroups.get(k) ?? evGroups.set(k, []).get(k)!).push(e);
  }
  for (const g of evGroups.values())
    if (g.length > 1) rows.push(row("duplikat", "Events", g.map((x) => x.id), `${g.length} acara dengan paroki "${g[0].parish}" dan angkatan ${g[0].angkatan}; dilaporkan saja, tidak digabung atau dihapus`));

  // ---- (b) EventKEP.Events ----
  const eventsOfKep = new Map<string, string[]>(); // resolved (existing or planned) events per EventKEP
  const eventKepUpdates: Upd[] = [];
  type Prop = { kep: AtRec; ev: string; via: string };
  const proposals: Prop[] = [];
  const claims = new Map<string, string[]>(); // event id -> EventKEP ids (existing links + proposals)
  const claim = (ev: string, kep: string) => (claims.get(ev) ?? claims.set(ev, []).get(ev)!).push(kep);
  for (const k of keps) {
    const linked = ids(k.fields[F.eventKep.events]);
    if (linked.length) {
      eventsOfKep.set(k.id, linked);
      linked.forEach((e) => claim(e, k.id));
    }
  }
  for (const k of keps) {
    if (eventsOfKep.has(k.id)) {
      rows.push(row("cocok", "EventKEP", [k.id], "Events sudah terisi; tidak diubah"));
      continue;
    }
    const angkatan = typeof k.fields[F.eventKep.angkatan] === "number" ? (k.fields[F.eventKep.angkatan] as number) : null;
    const parishes = [...new Set(ids(k.fields[F.eventKep.penyelenggara]).map((o) => orgParokiNorm.get(o) ?? "").filter(Boolean))];
    const via = ` (paroki dari ${[...new Set(ids(k.fields[F.eventKep.penyelenggara]).map((o) => orgSrc.get(o) ?? "").filter(Boolean))].join(" / ") || "-"})`;
    if (angkatan == null || parishes.length !== 1) {
      rows.push(row("tidak cocok", "EventKEP", [k.id], (angkatan == null ? "Angkatan kosong" : parishes.length === 0 ? "Paroki tidak diketahui" : "Lebih dari satu paroki; tidak ditulis") + via));
      continue;
    }
    const cands = courseEvents.filter((e) => e.parish === parishes[0] && e.angkatan === angkatan);
    if (cands.length === 0) rows.push(row("tidak cocok", "EventKEP", [k.id], `Tidak ada Events untuk paroki "${parishes[0]}" angkatan ${angkatan}${via}`));
    else if (cands.length > 1) rows.push(row("duplikat", "EventKEP", [k.id, ...cands.map((c) => c.id)], `${cands.length} Events cocok untuk paroki "${parishes[0]}" angkatan ${angkatan}; ambigu, tidak ditulis${via}`));
    else {
      proposals.push({ kep: k, ev: cands[0].id, via });
      claim(cands[0].id, k.id);
    }
  }
  for (const p of proposals) {
    const who = claims.get(p.ev)!;
    if (who.length > 1) rows.push(row("duplikat", "EventKEP", [...new Set(who), p.ev], "Events yang sama diklaim lebih dari satu EventKEP; tidak ditulis"));
    else {
      eventKepUpdates.push({ id: p.kep.id, fields: { [F.eventKep.events]: [p.ev] } });
      eventsOfKep.set(p.kep.id, [p.ev]);
      rows.push(row("rencana tulis", "EventKEP", [p.kep.id, p.ev], `Paroki + angkatan cocok dengan satu Events${p.via}`, "isi field Events"));
    }
  }

  // ---- (a) BabKEP -> SubEvent ----
  const copied = new Set<string>();
  const maxUrutan = new Map<string, number>();
  for (const s of subs) {
    for (const m of str(s.fields[F.subEvent.keterangan]).matchAll(LEGACY)) copied.add(m[1]);
    const u = s.fields[F.subEvent.urutan];
    if (typeof u === "number") for (const e of ids(s.fields[F.subEvent.acara])) maxUrutan.set(e, Math.max(maxUrutan.get(e) ?? 0, u));
  }
  type Pending = { bab: AtRec; ev: string; agenda: string; date: string };
  const pending: Pending[] = [];
  for (const b of babs) {
    if (copied.has(b.id)) {
      rows.push(row("cocok", "BabKEP", [b.id], "Sudah disalin ke SubEvent (kunci legacy)"));
      continue;
    }
    const agenda = str(b.fields[F.babKep.bab]);
    const evs = [...new Set(ids(b.fields[F.babKep.eventKep]).flatMap((k) => eventsOfKep.get(k) ?? []))];
    if (!agenda) rows.push(row("tidak cocok", "BabKEP", [b.id], "Nilai Bab kosong; tidak disalin"));
    else if (evs.length === 0) rows.push(row("tidak cocok", "BabKEP", [b.id], "EventKEP asal belum terpetakan ke Events; tidak disalin"));
    else if (evs.length > 1) rows.push(row("duplikat", "BabKEP", [b.id, ...evs], "Tertaut ke lebih dari satu Events; tidak disalin"));
    else pending.push({ bab: b, ev: evs[0], agenda, date: str(b.fields[F.babKep.tanggal]).slice(0, 10) });
  }
  const order = (a: string) => { const i = BAB_ORDER.indexOf(a); return i < 0 ? BAB_ORDER.length : i; };
  const subEvents: SubCreate[] = [];
  const perEvent = new Map<string, Pending[]>();
  for (const p of pending) (perEvent.get(p.ev) ?? perEvent.set(p.ev, []).get(p.ev)!).push(p);
  for (const [ev, list] of perEvent) {
    list.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || order(a.agenda) - order(b.agenda) || a.bab.id.localeCompare(b.bab.id));
    list.forEach((p, i) => {
      const fields: Record<string, unknown> = {
        [F.subEvent.agenda]: p.agenda,
        [F.subEvent.acara]: [ev],
        [F.subEvent.urutan]: (maxUrutan.get(ev) ?? 0) + i + 1,
        [F.subEvent.keterangan]: `legacy:${p.bab.id}`,
      };
      if (p.date) fields[F.subEvent.tanggal] = p.date;
      const pj = ids(p.bab.fields[F.babKep.pengajar]);
      if (pj.length) fields[F.subEvent.pengajar] = pj;
      subEvents.push({ legacyId: p.bab.id, fields });
      rows.push(row("rencana tulis", "BabKEP", [p.bab.id, ev], `Salin "${p.agenda}"${p.date ? ` (${p.date})` : ""} ke SubEvent`, `buat baris SubEvent urutan ${fields[F.subEvent.urutan]}`));
    });
  }
  const sortObj = (o: Record<string, unknown>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const entries = [
    ...penyelenggaraUpdates.map((u) => `P|${u.id}|${sortObj(u.fields)}`),
    ...eventKepUpdates.map((u) => `E|${u.id}|${sortObj(u.fields)}`),
    ...subEvents.map((u) => `S|${u.legacyId}|${sortObj(u.fields)}`),
  ].sort();
  const hash = createHash("sha256").update(entries.join("\n")).digest("hex");
  return { hash, rows, subEvents, eventKepUpdates, penyelenggaraUpdates };
}

export function planCsv(plan: Plan): string {
  const rows = plan.rows.map((r) => ({ jenis: r.jenis, tabel: r.tabel, "record id(s)": r.ids, keterangan: r.keterangan, rencana: r.rencana }));
  const note = (k: string) => ({ jenis: "catatan", tabel: "-", "record id(s)": "", keterangan: k, rencana: "" });
  const notes = [
    note(`Plan hash: ${plan.hash} (pakai --expect-hash=${plan.hash} saat --apply)`),
    note(`Jumlah tulis: SubEvent=${plan.subEvents.length}, EventKEP.Events=${plan.eventKepUpdates.length}, Pengelenggara KEP.Paroki=${plan.penyelenggaraUpdates.length}`),
    note("Urutan SubEvent baru ditambahkan setelah Urutan terbesar yang sudah ada pada Events yang sama"),
  ];
  return toCsv([...notes, ...rows]);
}

// ---- data sources ----
export function createSnapshotSource(dir: string): DataSource {
  const refuse = () => { throw new Error("Snapshot is read only"); };
  return {
    kind: "snapshot",
    async read(table) {
      const f = SOURCES.find((s) => s.table === table);
      if (!f) throw new Error(`Unknown table ${table}`);
      const path = join(dir, f.file);
      if (!existsSync(path)) throw new Error(`Missing snapshot file ${path}`);
      const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const arr = Array.isArray(j) ? j : (j as { records?: unknown }).records;
      if (!Array.isArray(arr)) throw new Error(`${f.file}: expected an array of records`);
      return arr as AtRec[];
    },
    create: refuse,
    update: refuse,
  };
}

export async function createLiveSource(): Promise<DataSource> {
  if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error("Live mode needs AIRTABLE_TOKEN and AIRTABLE_BASE_ID");
  const c = await import("@/lib/airtable/client");
  return {
    kind: "live",
    read: (table) => c.listRecords(table, { fields: [...SOURCES, { table: T.auditKep, file: "", fields: [F.auditKep.aksi] }].find((s) => s.table === table)!.fields }),
    create: (table, rows) => c.createRecords(table, rows),
    update: (table, rows, extra) => c.updateRecords(table, rows, extra),
  };
}

// ---- apply ----
const BATCH = 10;
async function chunked<I>(items: I[], sleep: (ms: number) => Promise<void>, fn: (b: I[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += BATCH) {
    if (i > 0) await sleep(250);
    await fn(items.slice(i, i + BATCH));
  }
}

export type ApplyResult = { counts: Record<string, number>; error?: string };

/** Re-reads the table right before each batch and drops targets whose field became non-empty meanwhile. */
async function stillEmpty(src: DataSource, table: string, field: string, batch: Upd[]): Promise<Upd[]> {
  const byId = new Map((await src.read(table)).map((r) => [r.id, r]));
  return batch.filter((u) => {
    const r = byId.get(u.id);
    return !!r && empty(r.fields[field]);
  });
}

/** Writes only. Never throws for write errors: returns the counts so far and the error. */
export async function applyPlan(src: DataSource, plan: Plan, sleep: (ms: number) => Promise<void>): Promise<ApplyResult> {
  if (src.kind !== "live") throw new Error("Apply needs a live source");
  const counts = { paroki_diisi: 0, events_diisi: 0, subevent_dibuat: 0, dilewati: 0 };
  try {
    await chunked(plan.penyelenggaraUpdates, sleep, async (b) => {
      const ok = await stillEmpty(src, T.penyelenggaraKep, F.penyelenggaraKep.paroki, b);
      counts.dilewati += b.length - ok.length;
      if (ok.length) await src.update(T.penyelenggaraKep, ok, new Set([F.penyelenggaraKep.paroki]));
      counts.paroki_diisi += ok.length;
    });
    await chunked(plan.eventKepUpdates, sleep, async (b) => {
      const ok = await stillEmpty(src, T.eventKep, F.eventKep.events, b);
      counts.dilewati += b.length - ok.length;
      if (ok.length) await src.update(T.eventKep, ok);
      counts.events_diisi += ok.length;
    });
    await chunked(plan.subEvents, sleep, async (b) => {
      await src.create(T.subEvent, b.map((s) => s.fields));
      counts.subevent_dibuat += b.length;
    });
  } catch (e) {
    return { counts, error: e instanceof Error ? e.message : "error" };
  }
  return { counts };
}

/** Counts only, never names. Pelaku is an email field live, so it is the operator's email. */
export async function writeApplyAudit(src: DataSource, actorEmail: string, r: ApplyResult): Promise<void> {
  await src.create(T.auditKep, [
    {
      [F.auditKep.aksi]: "legacy_map_apply",
      [F.auditKep.pelaku]: actorEmail,
      [F.auditKep.targetId]: "map-legacy",
      [F.auditKep.sesudah]: JSON.stringify({ ...r.counts, ...(r.error ? { gagal: true } : {}) }),
    },
  ]);
}

// ---- CLI ----
export type Deps = { env?: Record<string, string | undefined>; source?: DataSource; outDir?: string; sleep?: (ms: number) => Promise<void>; log?: (s: string) => void };

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const flag = (n: string) => argv.includes(n);
  const val = (n: string) => {
    const i = argv.findIndex((a) => a === n || a.startsWith(`${n}=`));
    if (i < 0) return undefined;
    return argv[i].includes("=") ? argv[i].slice(n.length + 1) : argv[i + 1];
  };
  const apply = flag("--apply");
  const snapshot = val("--from-snapshot");
  if (apply && flag("--dry-run")) { log("--apply and --dry-run are mutually exclusive"); return 2; }
  if (apply && !argv.includes("--confirm=YA")) { log("Refused: --apply needs --confirm=YA. Nothing was read or written."); return 2; }
  if (apply && (snapshot || deps.source?.kind === "snapshot")) { log("Refused: --apply cannot run from a snapshot."); return 2; }
  const env = deps.env ?? process.env;
  const actor = (env.MAP_LEGACY_ACTOR_EMAIL ?? "").trim();
  if (apply && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor)) { log("Refused: --apply needs MAP_LEGACY_ACTOR_EMAIL set to a valid email (audit Pelaku)."); return 2; }
  const expect = val("--expect-hash");
  if (apply && !expect) { log("Refused: --apply needs --expect-hash=<hash> from the approved dry-run."); return 2; }
  if (flag("--from-snapshot") && !snapshot) { log("--from-snapshot needs a directory"); return 2; }

  let src: DataSource;
  try {
    src = deps.source ?? (snapshot ? createSnapshotSource(resolve(snapshot)) : await createLiveSource());
  } catch (e) {
    log(`Cannot start: ${e instanceof Error ? e.message : "error"}`);
    return 1;
  }
  try {
    const data: Record<string, AtRec[]> = {};
    for (const s of SOURCES) data[s.table] = await src.read(s.table);
    const plan = buildPlan(data);
    const outDir = resolve(deps.outDir ?? val("--out") ?? "reports");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "legacy-mapping.csv"), "﻿" + planCsv(plan));
    const n = (j: Jenis) => plan.rows.filter((r) => r.jenis === j).length;
    log(`Mode: ${apply ? "APPLY" : "dry-run"} (${src.kind}). cocok=${n("cocok")} tidak cocok=${n("tidak cocok")} duplikat=${n("duplikat")} rencana tulis=${n("rencana tulis")}`);
    log(`Planned: SubEvent baru=${plan.subEvents.length}, EventKEP.Events=${plan.eventKepUpdates.length}, Pengelenggara KEP.Paroki=${plan.penyelenggaraUpdates.length}`);
    log(`Report: ${join(outDir, "legacy-mapping.csv")}`);
    log(`Plan hash: ${plan.hash}`);
    if (apply) {
      if (plan.hash !== expect) { log("Refused: the plan changed since the approved dry-run (hash differs). Nothing was written."); return 2; }
      const prior = await src.read(T.auditKep);
      if (prior.some((r) => r.fields[F.auditKep.aksi] === "legacy_map_apply") && !flag("--rerun")) {
        log("Refused: an earlier legacy_map_apply audit row exists. Add --rerun to run again (idempotent).");
        return 2;
      }
      const res = await applyPlan(src, plan, sleep);
      const c = res.counts;
      log(`Applied: SubEvent dibuat=${c.subevent_dibuat}, Events diisi=${c.events_diisi}, Paroki diisi=${c.paroki_diisi}, dilewati=${c.dilewati}`);
      if (res.error) log(`Error: stopped part-way (${res.error}). Re-run with --rerun and a fresh --expect-hash is safe.`);
      let auditOk = true;
      try {
        await writeApplyAudit(src, actor, res);
      } catch (e) {
        auditOk = false;
        log(`Error: audit row NOT written (${e instanceof Error ? e.message : "error"}). Counts above are the record.`);
      }
      if (res.error || !auditOk) return 1;
    }
    return 0;
  } catch (e) {
    log(`Failed: ${e instanceof Error ? e.message : "error"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
