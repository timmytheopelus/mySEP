import { withAuth } from "@/lib/auth/guard";
import { HttpError } from "@/lib/http/errors";
import { createHash } from "node:crypto";
import { listRecords } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { logAudit } from "@/lib/audit/log";
import { json, tooMany } from "@/lib/http/auth-http";
import { importTarget, parseUpload } from "@/lib/kep/importHttp";
import { RegistrationInputError, registerPeserta } from "@/lib/kep/registration";
import { limitKey, rateLimit } from "@/lib/ratelimit";
import { airtableMaxWaitMs, withAirtableDeadline } from "@/lib/airtable/deadline";

export const dynamic = "force-dynamic";
/**
 * Worst case per row on a warm cache (EventKEP, Events and Paroki reads are cached): TeamUmat match (1) + active
 * rows before/after (2) + Pendaftaran create (1) + new person create and race re-check (2) + consent audit (1) = 7
 * Airtable calls. 100 rows (MAX_ROWS) = 700 + 3 (previous run, start, finish) ~ 176 s at 4 req/s. IMPORT_BUDGET_MS
 * (default 240 s) stops starting new rows before maxDuration; those rows answer "ulangi" and a re-run of the same
 * file continues (registration dedups per person).
 */
export const maxDuration = 300;
const budgetMs = () => Number(process.env.IMPORT_BUDGET_MS) || 240_000;
/** Hard end of Airtable waits: maxDuration minus a margin for the closing audit rows (IMPORT_DEADLINE_MS overrides, tests). */
const hardMs = () => Number(process.env.IMPORT_DEADLINE_MS) || 270_000;

type Summary = { registered: number; alreadyRegistered: number; failed: number; failedRows: { row: number; message: string }[]; ulang?: boolean };
const inflight = new Map<string, Promise<Summary>>();

const RUNNING_WINDOW_MS = 6 * 60_000;
type Stored = Summary & { opId?: string; t?: number; transien?: number };

/**
 * Looks at the AuditKEP rows of this KEP for the same (kep, file) opId.
 * replay: a finished run without transient failures (all failures, if any, were validation failures).
 * running: a recent start with no finish at or after it (a crashed run stops blocking after 6 minutes).
 */
async function previousRun(kepId: string, opId: string): Promise<{ replay: Summary | null; running: boolean }> {
  const AU = F.auditKep;
  const rows = await listRecords(T.auditKep, {
    fields: [AU.aksi, AU.targetId, AU.sesudah],
    filterByFormula: `AND(OR({${AU.aksi}}="import_peserta_selesai",{${AU.aksi}}="import_peserta_mulai"),{${AU.targetId}}="${kepId}")`,
  });
  let replay: Summary | null = null;
  const starts: number[] = [];
  const ends: number[] = [];
  for (const r of rows) {
    const aksi = r.fields[AU.aksi];
    if (r.fields[AU.targetId] !== kepId || (aksi !== "import_peserta_selesai" && aksi !== "import_peserta_mulai")) continue;
    let a: Stored;
    try {
      a = JSON.parse(String(r.fields[AU.sesudah] ?? "")) as Stored;
    } catch {
      continue;
    }
    if (a.opId !== opId) continue;
    if (aksi === "import_peserta_mulai") starts.push(a.t ?? 0);
    else {
      ends.push(a.t ?? 0);
      if (!a.transien) replay = { registered: a.registered, alreadyRegistered: a.alreadyRegistered, failed: a.failed, failedRows: a.failedRows ?? [] };
    }
  }
  const now = Date.now();
  const running = starts.some((st) => now - st < RUNNING_WINDOW_MS && !ends.some((en) => en >= st));
  return { replay, running };
}

/** Re-parses the uploaded file (client-sent rows are never trusted), then registers valid rows one by one. */
export const POST = withAuth<{ id: string }>(
  async (req, { session, params }) => {
    const lim = await rateLimit(limitKey("peserta-import-commit", session.accountId), 6, 600);
    if (!lim.ok) return tooMany(lim.retryAfter);
    const eventId = await importTarget(session, params.id);
    const { sha256, parsed } = await parseUpload(req);
    const opId = createHash("sha256").update(`${params.id}:${sha256}`).digest("hex");

    // Registered synchronously (before any await) so a concurrent double click always finds it.
    const running = inflight.get(opId);
    if (running) return json({ ...(await running), ulang: true });

    const hardAt = Date.now() + hardMs();
    const run = withAirtableDeadline(hardAt, async (): Promise<Summary> => {
      const earlier = await previousRun(params.id, opId);
      if (earlier.replay) return { ...earlier.replay, ulang: true };
      if (earlier.running) throw new HttpError(409, "Berkas ini sedang diproses. Tunggu sebentar lalu periksa hasilnya.");
      await logAudit({ actorEmail: session.email, action: "import_peserta_mulai", targetId: params.id, after: { opId, t: Date.now(), sha256, valid: parsed.rows.length, galat: parsed.errors.length } });
      let transien = 0;
      const s: Summary = { registered: 0, alreadyRegistered: 0, failed: parsed.errors.length, failedRows: [...parsed.errors] };
      const started = Date.now();
      for (const item of parsed.items) {
        // Stop starting rows when the time budget is spent OR less than one worst-case Airtable wait is left before the hard deadline.
        if (Date.now() - started > budgetMs() || hardAt - Date.now() < airtableMaxWaitMs()) {
          s.failed++;
          transien++;
          s.failedRows.push({ row: item.row, message: "Belum diproses (batas waktu). Unggah ulang berkas yang sama untuk melanjutkan." });
          continue;
        }
        try {
          const r = await registerPeserta(eventId, item.data, { actorEmail: session.email });
          if (r.status === "registered") s.registered++;
          else s.alreadyRegistered++;
        } catch (e) {
          s.failed++;
          if (!(e instanceof RegistrationInputError)) transien++;
          s.failedRows.push({ row: item.row, message: e instanceof RegistrationInputError ? e.message : "Gagal diproses. Coba ulangi nanti." });
        }
      }
      s.failedRows.sort((a, b) => a.row - b.row);
      try {
        await logAudit({
          actorEmail: session.email,
          action: "import_peserta_selesai",
          targetId: params.id,
          after: { opId, t: Date.now(), transien, sha256, registered: s.registered, alreadyRegistered: s.alreadyRegistered, failed: s.failed, failedRows: s.failedRows.slice(0, 50) },
        });
      } catch {
        /* registerPeserta dedups per person, so a re-run after a missing "selesai" row is safe */
      }
      return s;
    });
    inflight.set(opId, run);
    try {
      return json(await run);
    } finally {
      inflight.delete(opId);
    }
  },
  { roles: ["PIC"], multipart: true },
);
