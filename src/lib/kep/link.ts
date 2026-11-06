import "server-only";
import QRCode from "qrcode";
import { getRecord, listRecords } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { assertKepInScope, requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { logAudit } from "@/lib/audit/log";
import { HttpError } from "@/lib/http/errors";
import { limitKey, rateLimit } from "@/lib/ratelimit";
import { LINK_ROTASI, currentLinkVersion, registrationTokenExpiry, signRegistrationToken } from "@/lib/kep/registration";

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;

export type LinkDaftar = { url: string; qr: string; kadaluarsa: string; versi: number };

/** Fixed, configured origin; the link is never derived from the request. */
function baseUrl(): string {
  const raw = (process.env.APP_BASE_URL ?? "").trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    return u.origin;
  } catch {
    throw new HttpError(503, "Tautan belum dapat dibuat: alamat aplikasi belum diatur. Hubungi SEP.");
  }
}

async function ownEvent(actor: Session, eventKepId: string) {
  requireRole(actor, ["PIC"]);
  const { eventKep } = await assertKepInScope(actor, eventKepId);
  const eventId = ids(eventKep.fields[F.eventKep.events])[0];
  if (!eventId) throw new HttpError(409, "KEP belum memiliki acara");
  return { eventKep, eventId };
}

/**
 * Signed public registration URL + QR (PNG data URI; CSP img-src allows data:) for a Disetujui KEP of the actor's parish.
 * The token expires after 120 days or at Tanggal Selesai, and dies when the PIC rotates it.
 */
export async function getLinkDaftar(actor: Session, eventKepId: string, opts: { now?: Date } = {}): Promise<LinkDaftar> {
  const now = opts.now ?? new Date();
  const { eventKep, eventId } = await ownEvent(actor, eventKepId);
  if (str(eventKep.fields[F.eventKep.statusPersetujuan]) !== "Disetujui") throw new HttpError(409, "KEP belum disetujui SEP");
  const base = baseUrl();
  const rec = await getRecord(T.eventKep, eventKepId);
  const exp = registrationTokenExpiry(now, str(rec.fields[F.eventKep.tanggalSelesai]));
  if (exp.getTime() <= now.getTime()) throw new HttpError(409, "Pendaftaran sudah ditutup (tanggal selesai terlewati)");
  const versi = await currentLinkVersion(eventId);
  let token: string;
  try {
    token = signRegistrationToken(eventId, { version: versi, expiresAt: exp, now });
  } catch {
    throw new HttpError(503, "Tautan belum dapat dibuat: kunci pendaftaran belum diatur. Hubungi SEP.");
  }
  const url = `${base}/daftar/${token}`;
  const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 240 });
  // Lightweight trace: once per hour per actor and KEP, ids only; a failed trace never blocks viewing.
  try {
    const lim = await rateLimit(limitKey("link-dilihat", actor.accountId, eventKepId), 1, 3600);
    if (lim.ok) await logAudit({ actorEmail: actor.email, action: "link_daftar_dilihat", targetId: eventKepId });
  } catch {
    /* best effort */
  }
  return { url, qr, kadaluarsa: exp.toISOString(), versi };
}

/**
 * Invalidates every link issued before (adds a rotation marker to AuditKEP; no new field). Idempotent per opId.
 * Audit first: when the marker cannot be written nothing changes.
 */
export async function rotateLinkDaftar(actor: Session, eventKepId: string, opId: string): Promise<{ versi: number }> {
  if (typeof opId !== "string" || !OP_ID.test(opId)) throw new HttpError(422, "opId tidak valid");
  const { eventId } = await ownEvent(actor, eventKepId);
  const AU = F.auditKep;
  const rows = await listRecords(T.auditKep, {
    fields: [AU.aksi, AU.targetId, AU.sesudah],
    filterByFormula: `AND({${AU.aksi}}="${LINK_ROTASI}",{${AU.targetId}}="${eventId}",{${AU.opId}}="${opId}")`,
  });
  for (const r of rows) {
    if (r.fields[AU.aksi] !== LINK_ROTASI || r.fields[AU.targetId] !== eventId) continue;
    try {
      const m = JSON.parse(str(r.fields[AU.sesudah])) as { v?: unknown; opId?: unknown };
      if (m.opId === opId && typeof m.v === "number") return { versi: m.v };
    } catch {
      /* not one of ours */
    }
  }
  const cur = await currentLinkVersion(eventId);
  const next = cur + 1;
  await logAudit({ actorEmail: actor.email, action: LINK_ROTASI, targetId: eventId, before: { v: cur }, after: { v: next, opId }, opId });
  return { versi: next };
}
