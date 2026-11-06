import "server-only";
import { writeAudit } from "@/lib/accounts/repo";

const MAX = 4000;
const text = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > MAX ? s.slice(0, MAX) : s;
};

/**
 * Append-only AuditKEP row. Throws when the write fails: callers that change state must write the
 * audit first and abort on failure (same convention as account management).
 */
export async function logAudit(entry: { actorEmail: string; action: string; targetId: string; before?: unknown; after?: unknown }): Promise<void> {
  await writeAudit({
    aksi: entry.action,
    pelaku: entry.actorEmail,
    targetId: entry.targetId,
    sebelum: text(entry.before),
    sesudah: text(entry.after),
  });
}
