import { withAuth } from "@/lib/auth/guard";
import { createHash } from "node:crypto";
import { listRecords } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { logAudit } from "@/lib/audit/log";
import { json, tooMany } from "@/lib/http/auth-http";
import { importTarget, parseUpload } from "@/lib/kep/importHttp";
import { RegistrationInputError, registerPeserta } from "@/lib/kep/registration";
import { limitKey, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Summary = { registered: number; alreadyRegistered: number; failed: number; failedRows: { row: number; message: string }[]; ulang?: boolean };
const inflight = new Map<string, Promise<Summary>>();

/** Earlier finished import of the same (kep, file): the stored summary, so a double click never re-registers. */
async function previousRun(kepId: string, opId: string): Promise<Summary | null> {
  const AU = F.auditKep;
  const rows = await listRecords(T.auditKep, {
    fields: [AU.aksi, AU.targetId, AU.sesudah],
    filterByFormula: `AND({${AU.aksi}}="import_peserta_selesai",{${AU.targetId}}="${kepId}")`,
  });
  for (const r of rows) {
    if (r.fields[AU.aksi] !== "import_peserta_selesai" || r.fields[AU.targetId] !== kepId) continue;
    try {
      const a = JSON.parse(String(r.fields[AU.sesudah] ?? "")) as Summary & { opId?: string };
      if (a.opId === opId) return { registered: a.registered, alreadyRegistered: a.alreadyRegistered, failed: a.failed, failedRows: a.failedRows ?? [] };
    } catch {
      /* not ours */
    }
  }
  return null;
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

    const run = (async (): Promise<Summary> => {
      const earlier = await previousRun(params.id, opId);
      if (earlier) return { ...earlier, ulang: true };
      await logAudit({ actorEmail: session.email, action: "import_peserta_mulai", targetId: params.id, after: { opId, sha256, valid: parsed.rows.length, galat: parsed.errors.length } });
      const s: Summary = { registered: 0, alreadyRegistered: 0, failed: parsed.errors.length, failedRows: [...parsed.errors] };
      for (const item of parsed.items) {
        try {
          const r = await registerPeserta(eventId, item.data, { actorEmail: session.email });
          if (r.status === "registered") s.registered++;
          else s.alreadyRegistered++;
        } catch (e) {
          s.failed++;
          s.failedRows.push({ row: item.row, message: e instanceof RegistrationInputError ? e.message : "Gagal diproses. Coba ulangi nanti." });
        }
      }
      s.failedRows.sort((a, b) => a.row - b.row);
      try {
        await logAudit({
          actorEmail: session.email,
          action: "import_peserta_selesai",
          targetId: params.id,
          after: { opId, sha256, registered: s.registered, alreadyRegistered: s.alreadyRegistered, failed: s.failed, failedRows: s.failedRows.slice(0, 50) },
        });
      } catch {
        /* registerPeserta dedups per person, so a re-run after a missing "selesai" row is safe */
      }
      return s;
    })();
    inflight.set(opId, run);
    try {
      return json(await run);
    } finally {
      inflight.delete(opId);
    }
  },
  { roles: ["PIC"], multipart: true },
);
