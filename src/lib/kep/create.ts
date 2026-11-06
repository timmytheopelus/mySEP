import "server-only";
import { createRecords, getRecord, listRecords } from "@/lib/airtable/client";
import { F, RESTRICTED, T, pickAllowedForRole } from "@/lib/airtable/schema";
import { requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { logAudit } from "@/lib/audit/log";
import { HttpError } from "@/lib/http/errors";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { KEP_TEMPLATE, parseIsoDate, scheduleDates } from "@/lib/kep/template";

const MAX_ANGKATAN = 9999;
const CHUNK = 10;
const DAY_MS = 86_400_000;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** What exists after a failed creation; a retry of the same request resumes from it. Nothing is ever deleted. */
export type CreatedRows = { penyelenggaraId?: string; eventId?: string; eventKepId?: string; subEventIds: string[] };

export class KepPartialError extends Error {
  constructor(
    public readonly created: CreatedRows,
    public readonly cause: unknown,
  ) {
    super("Pembuatan KEP belum selesai. Coba lagi untuk melanjutkan.");
    this.name = "KepPartialError";
  }
}

export type CreateKepInput = { parokiId?: string; angkatan: number; tanggalMulai: string };

// Per-process guard against two identical requests racing (Airtable has no conditional write).
const inFlight = new Set<string>();

// Restricted fields the server sets itself on create (never from request data).
const KEP_SERVER_FIELDS = new Set([F.eventKep.statusPersetujuan, F.eventKep.penyelenggara]);
const ORG_SERVER_FIELDS = RESTRICTED[T.penyelenggaraKep];

/** Escape a value for a double-quoted Airtable formula string (values here come from our own data). */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function validate(input: CreateKepInput, now: Date): { angkatan: number; tanggalMulai: string } {
  const { angkatan, tanggalMulai } = input ?? ({} as CreateKepInput);
  if (typeof angkatan !== "number" || !Number.isInteger(angkatan) || angkatan < 1 || angkatan > MAX_ANGKATAN)
    throw new HttpError(422, "Angkatan harus bilangan bulat positif");
  let start: number;
  try {
    start = parseIsoDate(tanggalMulai);
  } catch {
    throw new HttpError(422, "Tanggal mulai tidak valid (format TTTT-BB-HH)");
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (start < today - DAY_MS) throw new HttpError(422, "Tanggal mulai tidak boleh sudah lewat");
  return { angkatan, tanggalMulai };
}

/**
 * PIC creates a KEP for their OWN paroki: Pengelenggara KEP (find or create), Events, EventKEP (Diajukan),
 * audit row and all SubEvent rows of the fixed template. All validation runs before the first write.
 * Retries are idempotent: an earlier attempt of ours (marked by the `create_kep_mulai` audit row) is resumed,
 * a same-named Events row without that marker (legacy data) is refused with 409.
 */
export async function createKep(actor: Session, input: CreateKepInput, opts: { now?: Date } = {}) {
  requireRole(actor, ["PIC"]);
  const own = actor.parokiId as string;
  const parokiId = input?.parokiId ?? own;
  if (parokiId !== own) throw new HttpError(404);
  const { angkatan, tanggalMulai } = validate(input, opts.now ?? new Date());

  let parokiNama: string;
  try {
    const p = await getRecord(T.paroki, own);
    parokiNama = String(p.fields[F.paroki.nama] ?? "").replace(/\s+/g, " ").trim();
  } catch {
    throw new HttpError(404);
  }
  if (!parokiNama) throw new HttpError(422, "Nama paroki belum diisi");
  const nama = `KEP PAROKI ${parokiNama.toUpperCase()} ANGKATAN ${angkatan}`;
  const key = `KEP:${own}:${angkatan}`;
  if (inFlight.has(key)) throw new HttpError(409, "Pembuatan KEP ini sedang berjalan");
  inFlight.add(key);
  const created: CreatedRows = { subEventIds: [] };
  let wrote = false;
  try {
    // ---- reads and duplicate detection (no writes yet) ----
    const [events, keps, orgs, audits, subs] = await Promise.all([
      listRecords(T.events, { fields: [F.events.namaAcara], filterByFormula: `{${F.events.namaAcara}} = ${q(nama)}` }),
      listRecords(T.eventKep, { fields: [F.eventKep.events, F.eventKep.penyelenggara, F.eventKep.statusPersetujuan] }),
      listRecords(T.penyelenggaraKep, { fields: [F.penyelenggaraKep.paroki] }),
      listRecords(T.auditKep, { fields: [F.auditKep.aksi, F.auditKep.targetId], filterByFormula: `OR({${F.auditKep.aksi}} = "create_kep_mulai", {${F.auditKep.aksi}} = "create_kep")` }),
      listRecords(T.subEvent, { fields: [F.subEvent.acara, F.subEvent.urutan] }),
    ]);
    const auditOf = (aksi: string, target: string) =>
      audits.some((a) => a.fields[F.auditKep.aksi] === aksi && a.fields[F.auditKep.targetId] === target);
    const event = events.find((e) => e.fields[F.events.namaAcara] === nama);
    const started = auditOf("create_kep_mulai", key);
    if (event && !started) throw new HttpError(409, "KEP dengan paroki dan angkatan ini sudah ada");
    const kep = event ? keps.find((k) => ids(k.fields[F.eventKep.events]).includes(event.id)) : undefined;
    const existingSubs = new Map<number, string>();
    if (event)
      for (const s of subs)
        if (ids(s.fields[F.subEvent.acara]).includes(event.id) && typeof s.fields[F.subEvent.urutan] === "number")
          existingSubs.set(s.fields[F.subEvent.urutan] as number, s.id);
    if (event && kep && auditOf("create_kep", kep.id) && KEP_TEMPLATE.every((e) => existingSubs.has(e.urutan)))
      throw new HttpError(409, "KEP dengan paroki dan angkatan ini sudah ada");

    // ---- writes ----
    if (!started) {
      await logAudit({ actorEmail: actor.email, action: "create_kep_mulai", targetId: key, after: { nama, tanggalMulai } });
    }
    wrote = true;
    const org = orgs.find((o) => ids(o.fields[F.penyelenggaraKep.paroki]).includes(own));
    if (org) created.penyelenggaraId = org.id;
    else {
      const [r] = await createRecords(T.penyelenggaraKep, [{ [F.penyelenggaraKep.paroki]: [own] }], ORG_SERVER_FIELDS);
      created.penyelenggaraId = r.id;
    }
    if (event) created.eventId = event.id;
    else {
      const fields = pickAllowedForRole(T.events, actor.role, {
        [F.events.namaAcara]: nama,
        [F.events.kelompokAcara]: "KEP",
        [F.events.tanggalAcara]: tanggalMulai,
      });
      const [r] = await createRecords(T.events, [fields]);
      created.eventId = r.id;
    }
    if (kep) created.eventKepId = kep.id;
    else {
      const [r] = await createRecords(
        T.eventKep,
        [
          {
            [F.eventKep.events]: [created.eventId],
            [F.eventKep.statusPersetujuan]: "Diajukan",
            [F.eventKep.penyelenggara]: [created.penyelenggaraId],
          },
        ],
        KEP_SERVER_FIELDS,
      );
      created.eventKepId = r.id;
    }
    if (!auditOf("create_kep", created.eventKepId as string))
      await logAudit({ actorEmail: actor.email, action: "create_kep", targetId: created.eventKepId as string, after: { nama, parokiId: own, angkatan, tanggalMulai } });

    const dates = scheduleDates(tanggalMulai);
    const missing = KEP_TEMPLATE.filter((e) => !existingSubs.has(e.urutan));
    for (const e of KEP_TEMPLATE) if (existingSubs.has(e.urutan)) created.subEventIds.push(existingSubs.get(e.urutan) as string);
    for (let i = 0; i < missing.length; i += CHUNK) {
      const rows = missing.slice(i, i + CHUNK).map((e) =>
        pickAllowedForRole(T.subEvent, actor.role, {
          [F.subEvent.acara]: [created.eventId],
          [F.subEvent.agenda]: e.agenda,
          [F.subEvent.urutan]: e.urutan,
          [F.subEvent.tanggal]: dates[e.urutan - 1],
        }),
      );
      const made = await createRecords(T.subEvent, rows);
      made.forEach((r, j) => existingSubs.set(missing[i + j].urutan, r.id));
      created.subEventIds.push(...made.map((r) => r.id));
    }
    return {
      eventKepId: created.eventKepId as string,
      eventId: created.eventId as string,
      subEventIds: KEP_TEMPLATE.map((e) => existingSubs.get(e.urutan) as string),
    };
  } catch (e) {
    if (wrote && !(e instanceof HttpError)) throw new KepPartialError(created, e);
    throw e;
  } finally {
    inFlight.delete(key);
    if (wrote) invalidateKepCache();
  }
}
