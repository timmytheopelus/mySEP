import "server-only";
import { z } from "zod";
import { listRecords, updateRecords, type AtRecord } from "@/lib/airtable/client";
import { F, PENGAJAR_READ, PENGAJAR_STATUS_AKTIF, T, pickAllowedForRole } from "@/lib/airtable/schema";
import { parokiAllows, requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { logAudit } from "@/lib/audit/log";
import { HttpError } from "@/lib/http/errors";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { canonicalWatchUrl, parseYoutubeId } from "./youtube";

const REC_ID = /^rec[A-Za-z0-9]{10,}$/;
const MAX_BIO = 1000;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const isAktif = (v: unknown) => str(v).trim().toLowerCase() === PENGAJAR_STATUS_AKTIF.toLowerCase();

export type PewartaCard = { id: string; nama: string; babs: string[]; adaFoto: boolean };
export type PewartaDetail = PewartaCard & { bio: string; youtubeId: string | null; noHp?: string };

/** Plain text only: all tags and angle brackets removed, whitespace collapsed (newlines kept), capped. */
export function sanitizeBio(input: unknown): string {
  let s = str(input);
  let prev;
  do {
    prev = s;
    s = s.replace(/<[^>]*>/g, "");
  } while (s !== prev);
  s = s
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.slice(0, MAX_BIO).trim();
}

const CARD_FIELDS = [F.pengajarKep.nama, F.pengajarKep.status, F.pengajarKep.photo, PENGAJAR_READ.bab];
const DETAIL_FIELDS = [...CARD_FIELDS, F.pengajarKep.bioSingkat, F.pengajarKep.linkYoutube];

async function babNames(): Promise<Map<string, string>> {
  const rows = await listRecords(T.babKep, { fields: [F.babKep.bab] });
  return new Map(rows.map((r) => [r.id, str(r.fields[F.babKep.bab])]));
}

function toCard(r: AtRecord, babs: Map<string, string>): PewartaCard {
  const names = ids(r.fields[PENGAJAR_READ.bab]).map((b) => babs.get(b)).filter((n): n is string => !!n);
  return {
    id: r.id,
    nama: str(r.fields[F.pengajarKep.nama]).trim(),
    babs: [...new Set(names)],
    adaFoto: Array.isArray(r.fields[F.pengajarKep.photo]) && (r.fields[F.pengajarKep.photo] as unknown[]).length > 0,
  };
}

export function filterPewarta(cards: PewartaCard[], q?: { bab?: string; nama?: string }): PewartaCard[] {
  const nama = q?.nama?.trim().toLowerCase();
  const bab = q?.bab?.trim();
  return cards.filter((c) => (!nama || c.nama.toLowerCase().includes(nama)) && (!bab || c.babs.includes(bab)));
}

/** Active pewarta only. NoHP is never requested here, so it can never sit in a list result. */
export async function listPewarta(session: Session, q?: { bab?: string; nama?: string }): Promise<PewartaCard[]> {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  const [rows, babs] = await Promise.all([listRecords(T.pengajarKep, { fields: CARD_FIELDS }), babNames()]);
  const cards = rows
    .filter((r) => isAktif(r.fields[F.pengajarKep.status]))
    .map((r) => toCard(r, babs))
    .sort((a, b) => a.nama.localeCompare(b.nama));
  return filterPewarta(cards, q);
}

async function loadAktif(id: string, fields: string[]): Promise<AtRecord> {
  if (typeof id !== "string" || !REC_ID.test(id)) throw new HttpError(404);
  // id is regex-validated above, so it is safe to embed in the formula; also matched in code.
  const rows = await listRecords(T.pengajarKep, { fields, filterByFormula: `RECORD_ID() = "${id}"` });
  const r = rows.find((x) => x.id === id);
  if (!r || !isAktif(r.fields[F.pengajarKep.status])) throw new HttpError(404);
  return r;
}

/** PIC sees noHp only for a pewarta assigned to a Disetujui KEP of the own paroki (all linked KEPs must qualify). */
async function picMaySeeNoHp(session: Session, pengajarId: string): Promise<boolean> {
  if (session.role !== "PIC" || !session.parokiId) return false;
  const [subs, keps, orgs] = await Promise.all([
    listRecords(T.subEvent, { fields: [F.subEvent.acara, F.subEvent.pengajar] }),
    listRecords(T.eventKep, { fields: [F.eventKep.events, F.eventKep.statusPersetujuan, F.eventKep.penyelenggara] }),
    listRecords(T.penyelenggaraKep, { fields: [F.penyelenggaraKep.paroki] }),
  ]);
  const orgParoki = new Map(orgs.map((o) => [o.id, ids(o.fields[F.penyelenggaraKep.paroki])]));
  const parokiOf = (k: AtRecord) => ids(k.fields[F.eventKep.penyelenggara]).flatMap((o) => orgParoki.get(o) ?? []);
  const qualifies = (events: string[]) => {
    const ks = keps.filter((k) => ids(k.fields[F.eventKep.events]).some((e) => events.includes(e)));
    return (
      ks.length > 0 &&
      ks.every((k) => parokiAllows(session.parokiId as string, parokiOf(k)) && str(k.fields[F.eventKep.statusPersetujuan]) === "Disetujui")
    );
  };
  return subs.some((s) => ids(s.fields[F.subEvent.pengajar]).includes(pengajarId) && qualifies(ids(s.fields[F.subEvent.acara])));
}

export async function getPewarta(session: Session, id: string): Promise<PewartaDetail> {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  const [r, babs] = await Promise.all([loadAktif(id, DETAIL_FIELDS), babNames()]);
  const detail: PewartaDetail = {
    ...toCard(r, babs),
    bio: sanitizeBio(r.fields[F.pengajarKep.bioSingkat]),
    youtubeId: parseYoutubeId(str(r.fields[F.pengajarKep.linkYoutube])),
  };
  if (session.role === "SEP" || (await picMaySeeNoHp(session, id))) {
    // Separate single-record read; the value is never cached or logged.
    const p = await loadAktif(id, [F.pengajarKep.status, PENGAJAR_READ.noHp]);
    const noHp = str(p.fields[PENGAJAR_READ.noHp]).trim();
    if (noHp) detail.noHp = noHp;
  }
  return detail;
}

const Input = z
  .object({ linkYoutube: z.string().max(300).optional(), bioSingkat: z.string().max(20000).optional() })
  .strict()
  .refine((v) => v.linkYoutube !== undefined || v.bioSingkat !== undefined);

/** SEP only. Audit first (abort when it fails), then write; link must pass parseYoutubeId, bio is plain text. */
export async function updatePewartaProfile(actor: Session, id: string, input: { linkYoutube?: string; bioSingkat?: string }): Promise<void> {
  requireRole(actor, ["SEP"]);
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new HttpError(422, "Data profil tidak valid");
  const fields: Record<string, unknown> = {};
  const link = parsed.data.linkYoutube?.trim();
  if (link !== undefined) {
    if (link === "") fields[F.pengajarKep.linkYoutube] = null;
    else {
      const yt = parseYoutubeId(link);
      if (!yt) throw new HttpError(422, "Tautan harus berupa video YouTube (https)");
      fields[F.pengajarKep.linkYoutube] = canonicalWatchUrl(yt);
    }
  }
  if (parsed.data.bioSingkat !== undefined) fields[F.pengajarKep.bioSingkat] = sanitizeBio(parsed.data.bioSingkat);
  const before = await loadAktif(id, [F.pengajarKep.status, F.pengajarKep.linkYoutube, F.pengajarKep.bioSingkat]);
  const prior: Record<string, unknown> = {};
  for (const k of Object.keys(fields)) prior[k] = before.fields[k] ?? null;
  await logAudit({ actorEmail: actor.email, action: "update_profil_pewarta", targetId: id, before: prior, after: fields });
  try {
    await updateRecords(T.pengajarKep, [{ id, fields: pickAllowedForRole(T.pengajarKep, actor.role, fields) }]);
  } finally {
    invalidateKepCache(T.pengajarKep);
  }
}

const FOTO_HOST = /^([a-z0-9-]+\.)*airtableusercontent\.com$|^dl\.airtable\.com$/i;

/** Airtable thumbnail URL looked up server-side by record id (never from the client); host-restricted https. */
export async function fotoSource(session: Session, id: string): Promise<string> {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  const r = await loadAktif(id, [F.pengajarKep.status, F.pengajarKep.photo]);
  const att = (Array.isArray(r.fields[F.pengajarKep.photo]) ? (r.fields[F.pengajarKep.photo] as unknown[]) : [])[0] as
    | { url?: unknown; thumbnails?: { large?: { url?: unknown }; small?: { url?: unknown } } }
    | undefined;
  for (const cand of [att?.thumbnails?.large?.url, att?.thumbnails?.small?.url, att?.url]) {
    if (typeof cand !== "string") continue;
    try {
      const u = new URL(cand);
      if (u.protocol === "https:" && !u.username && !u.password && !u.port && FOTO_HOST.test(u.hostname)) return u.toString();
    } catch {
      /* try next */
    }
  }
  throw new HttpError(404);
}
