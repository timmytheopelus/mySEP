import "server-only";
import { getRecord, listRecords, updateRecords } from "@/lib/airtable/client";
import { F, T, pickAllowedForRole, restrictedFor } from "@/lib/airtable/schema";
import { listAllAccounts } from "@/lib/accounts/repo";
import { assertKepInScope, requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { logAudit } from "@/lib/audit/log";
import { appBaseUrl, sendMail } from "@/lib/email";
import { HttpError } from "@/lib/http/errors";
import { invalidateKepCache } from "@/lib/kep/readModel";

const MAX_CATATAN = 2000;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export type Keputusan = "Disetujui" | "Ditolak";

/** Recipients of a decision: active PIC accounts of the KEP's organizing paroki(s) + the submitter from the audit row. */
async function recipients(kepId: string, organizerIds: string[], submittedBy: string): Promise<{ email: string; nama?: string }[]> {
  const [orgs, accounts, audits] = await Promise.all([
    listRecords(T.penyelenggaraKep, { fields: [F.penyelenggaraKep.paroki] }),
    listAllAccounts(),
    listRecords(T.auditKep, {
      fields: [F.auditKep.aksi, F.auditKep.pelaku, F.auditKep.targetId],
      filterByFormula: `{${F.auditKep.aksi}} = "create_kep"`,
    }),
  ]);
  const parokis = new Set(orgs.filter((o) => organizerIds.includes(o.id)).flatMap((o) => ids(o.fields[F.penyelenggaraKep.paroki])));
  const out = new Map<string, { email: string; nama?: string }>();
  for (const a of accounts)
    if (a.active && a.role === "PIC" && a.parokiId && parokis.has(a.parokiId)) out.set(a.email, { email: a.email, nama: a.nama || undefined });
  // SubmittedBy on the EventKEP first; the create_kep audit row is the fallback (older rows).
  const submitters = [submittedBy];
  for (const a of audits)
    if (a.fields[F.auditKep.aksi] === "create_kep" && a.fields[F.auditKep.targetId] === kepId) submitters.push(str(a.fields[F.auditKep.pelaku]));
  for (const raw of submitters) {
    const email = raw.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !out.has(email)) out.set(email, { email });
  }
  return [...out.values()];
}

/**
 * SEP approves or rejects a submitted KEP. Audit row first (abort when it cannot be written), then the
 * SEP-only fields, then the emails (a mail failure never undoes the decision). Deciding again is a 409,
 * except Ditolak -> Disetujui with a catatan.
 */
export async function decideKep(actor: Session, eventKepId: string, decision: Keputusan, catatan: string): Promise<{ emailTerkirim: boolean }> {
  requireRole(actor, ["SEP"]);
  const { eventKep } = await assertKepInScope(actor, eventKepId);
  if (decision !== "Disetujui" && decision !== "Ditolak") throw new HttpError(422, "Keputusan tidak valid");
  const note = typeof catatan === "string" ? catatan.trim() : "";
  if (note.length > MAX_CATATAN) throw new HttpError(422, "Catatan terlalu panjang");
  if (decision === "Ditolak" && !note) throw new HttpError(422, "Catatan wajib diisi untuk penolakan");

  const current = str(eventKep.fields[F.eventKep.statusPersetujuan]);
  const reapprove = current === "Ditolak" && decision === "Disetujui";
  if (current !== "Diajukan" && !reapprove) throw new HttpError(409, "KEP ini sudah diputuskan");
  if (reapprove && !note) throw new HttpError(422, "Catatan wajib diisi untuk mengubah penolakan menjadi persetujuan");

  await logAudit({
    actorEmail: actor.email,
    action: decision === "Disetujui" ? "kep_setuju" : "kep_tolak",
    targetId: eventKepId,
    before: { status: current, catatan: str(eventKep.fields[F.eventKep.catatanSep]) },
    after: { status: decision, catatan: note },
  });
  try {
    await updateRecords(
      T.eventKep,
      [
        {
          id: eventKepId,
          fields: pickAllowedForRole(T.eventKep, actor.role, { [F.eventKep.statusPersetujuan]: decision, [F.eventKep.catatanSep]: note }),
        },
      ],
      restrictedFor(T.eventKep, actor.role),
    );
  } finally {
    invalidateKepCache();
  }

  let emailTerkirim = true;
  try {
    let kepNama = "KEP";
    const eventId = ids(eventKep.fields[F.eventKep.events])[0];
    if (eventId) kepNama = str((await getRecord(T.events, eventId)).fields[F.events.namaAcara]) || kepNama;
    let link = "";
    try {
      link = `${appBaseUrl()}/`;
    } catch {
      /* APP_BASE_URL not configured: the decision mail goes out without a link */
    }
    const to = await recipients(eventKepId, ids(eventKep.fields[F.eventKep.penyelenggara]), str(eventKep.fields[F.eventKep.submittedBy]));
    const results = await Promise.allSettled(
      to.map((r) => sendMail(r.email, "kep_keputusan", { link, nama: r.nama, kepNama, keputusan: decision, catatan: note })),
    );
    if (results.some((r) => r.status === "rejected")) emailTerkirim = false;
  } catch {
    emailTerkirim = false;
  }
  if (!emailTerkirim) {
    console.error("kep decision email failed"); // the decision itself is already saved and audited
    try {
      await logAudit({ actorEmail: actor.email, action: "decision_email_failed", targetId: eventKepId, after: { keputusan: decision } });
    } catch {
      console.error("audit of email failure also failed");
    }
  }
  return { emailTerkirim };
}

export type AntreanItem = { id: string; nama: string; parokiNama: string; tanggalMulai: string; status: string; catatan: string };

/** SEP queue: KEPs waiting for a decision (Diajukan first) and rejected ones that can still be reversed. */
export async function listKepQueue(actor: Session): Promise<AntreanItem[]> {
  requireRole(actor, ["SEP"]);
  const [keps, orgs, paroki] = await Promise.all([
    listRecords(T.eventKep, { fields: [F.eventKep.statusPersetujuan, F.eventKep.catatanSep, F.eventKep.events, F.eventKep.penyelenggara] }),
    listRecords(T.penyelenggaraKep, { fields: [F.penyelenggaraKep.paroki] }),
    listRecords(T.paroki, { fields: [F.paroki.nama] }),
  ]);
  const parokiNama = new Map(paroki.map((p) => [p.id, str(p.fields[F.paroki.nama])]));
  const orgParoki = new Map(orgs.map((o) => [o.id, ids(o.fields[F.penyelenggaraKep.paroki])]));
  const pending = keps.filter((k) => ["Diajukan", "Ditolak"].includes(str(k.fields[F.eventKep.statusPersetujuan])));
  const items = await Promise.all(
    pending.map(async (k): Promise<AntreanItem> => {
      let nama = "KEP";
      let tanggalMulai = "";
      const eventId = ids(k.fields[F.eventKep.events])[0];
      if (eventId) {
        try {
          const ev = await getRecord(T.events, eventId);
          nama = str(ev.fields[F.events.namaAcara]) || nama;
          tanggalMulai = str(ev.fields[F.events.tanggalAcara]).slice(0, 10);
        } catch {
          /* leave defaults */
        }
      }
      const pn = ids(k.fields[F.eventKep.penyelenggara]).flatMap((o) => orgParoki.get(o) ?? []).map((p) => parokiNama.get(p) ?? "").filter(Boolean);
      return {
        id: k.id,
        nama,
        parokiNama: pn.join(", ") || "-",
        tanggalMulai,
        status: str(k.fields[F.eventKep.statusPersetujuan]),
        catatan: str(k.fields[F.eventKep.catatanSep]),
      };
    }),
  );
  return items.sort((a, b) => Number(b.status === "Diajukan") - Number(a.status === "Diajukan") || a.nama.localeCompare(b.nama));
}


