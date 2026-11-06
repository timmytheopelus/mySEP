import "server-only";
import { listRecords, type AtRecord } from "@/lib/airtable/client";

// ---------------------------------------------------------------------------------------------
// Short-lived per-process table cache (shared by the read model, the scope guard and the absensi sheet).
// Concurrent callers share one in-flight read (single flight); a failed refresh serves the last good rows and
// backs off for a few seconds (cold failure: rethrows, also backed off); invalidateTable bumps a generation so an
// older in-flight read can neither be served as fresh nor stored over the invalidation. Returned arrays are
// shared: treat as read-only. The key is table + sorted field set + formula, so a scoped (filtered) read never
// serves another scope.
// ---------------------------------------------------------------------------------------------
export const TABLE_TTL_MS = 45_000;
const FAIL_BACKOFF_MS = 10_000;

import { genOf, lastGood, tableCache, type Entry } from "./cacheStore";
export { cacheAge, invalidateTable, onInvalidate, resetReadCache } from "./cacheStore";

export type CacheOpts = {
  /** Fresh for this long (default 45 s). */
  ttlMs?: number;
  /** Treat an entry older than this as stale (forced refresh, e.g. after a miss); still single flight. */
  maxAgeMs?: number;
};

export function cachedList(table: string, fields: string[], filterByFormula?: string, o: CacheOpts = {}): Promise<AtRecord[]> {
  const fl = [...new Set(fields)].sort();
  const key = `${table}|${fl.join(",")}|${filterByFormula ?? ""}`;
  const hit = tableCache.get(key);
  const now = Date.now();
  // AIRTABLE_CACHE_TTL_MS can only SHORTEN every TTL (0 = no reuse across requests; in-flight reads still shared).
  // Used by the Playwright suite, whose fake Airtable is reset between tests behind the app's back.
  const cap = process.env.AIRTABLE_CACHE_TTL_MS === undefined || process.env.AIRTABLE_CACHE_TTL_MS === "" ? Infinity : Math.max(0, Number(process.env.AIRTABLE_CACHE_TTL_MS) || 0);
  const ttl = Math.min(o.ttlMs ?? TABLE_TTL_MS, o.maxAgeMs ?? Infinity, cap);
  if (hit && hit.gen === genOf(table)) {
    if (hit.failedAt === undefined && (now - hit.at < ttl || hit.inflight)) return hit.p;
    if (hit.failedAt !== undefined && now - hit.failedAt < FAIL_BACKOFF_MS) return hit.p;
  }
  const gen = genOf(table);
  const entry: Entry = { at: now, gen, p: Promise.resolve([]), inflight: true };
  entry.p = listRecords(table, { fields: fl, ...(filterByFormula ? { filterByFormula } : {}) }).then(
    (rows) => {
      entry.inflight = false;
      entry.at = Date.now();
      if (gen === genOf(table)) lastGood.set(key, rows);
      return rows;
    },
    (err) => {
      entry.inflight = false;
      entry.failedAt = Date.now();
      const stale = lastGood.get(key);
      if (stale) return stale;
      throw err; // rejected promise stays cached during the backoff window
    },
  );
  entry.p.catch(() => undefined);
  tableCache.set(key, entry);
  return entry.p;
}

