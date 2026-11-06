import "server-only";
import { writeAudit, writeAuditBatch, type AuditRow } from "@/lib/accounts/repo";

const MAX = 4000;
const text = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > MAX ? s.slice(0, MAX) : s;
};

export type AuditEntry = {
  /** Signed-in actor: must be a valid email (AuditKEP.Pelaku is an email field). Omit for public/system flows. */
  actorEmail?: string;
  /** Marker for flows without an account ("publik"); stored in Sesudah.actorType, never in Pelaku. */
  actorType?: "publik" | "sistem";
  action: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  opId?: string;
};
const toRow = (entry: AuditEntry): AuditRow => ({
  aksi: entry.action,
  pelaku: entry.actorEmail,
  actorType: entry.actorType,
  targetId: entry.targetId,
  sebelum: text(entry.before),
  sesudah: text(entry.after),
  opId: entry.opId,
});

/**
 * Append-only AuditKEP row. Throws when the write fails: callers that change state must write the
 * audit first and abort on failure (same convention as account management).
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  await writeAudit(toRow(entry));
}

/** Several rows in batched requests (10 per call). Same failure rule as logAudit. */
export async function logAuditBatch(entries: AuditEntry[]): Promise<void> {
  await writeAuditBatch(entries.map(toRow));
}
