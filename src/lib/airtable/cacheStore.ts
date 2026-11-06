import type { AtRecord } from "@/lib/airtable/client";
import { T } from "@/lib/airtable/schema";

/** State of the shared read cache (no client import, so test helpers can reset it). Logic: ./cache.ts */
export const tableGen = new Map<string, number>();
export const genOf = (t: string) => tableGen.get(t) ?? 0;
export type Entry = { at: number; gen: number; p: Promise<AtRecord[]>; failedAt?: number; inflight?: boolean };
export const tableCache = new Map<string, Entry>();
export const lastGood = new Map<string, AtRecord[]>();
export const listeners = new Set<(table?: string) => void>();

/** Age (ms) of the cached entry for this exact read, or Infinity when there is none. */
export function cacheAge(table: string, fields: string[], filterByFormula?: string): number {
  const key = `${table}|${[...new Set(fields)].sort().join(",")}|${filterByFormula ?? ""}`;
  const hit = tableCache.get(key);
  return hit && hit.gen === genOf(table) ? Date.now() - hit.at : Infinity;
}

/** Call after any write to `table` (or without argument to drop everything). */
export function invalidateTable(table?: string): void {
  if (table) tableGen.set(table, genOf(table) + 1);
  else for (const t of Object.values(T)) tableGen.set(t, genOf(t) + 1);
  for (const k of [...tableCache.keys()]) if (!table || k.startsWith(`${table}|`)) tableCache.delete(k);
  for (const k of [...lastGood.keys()]) if (!table || k.startsWith(`${table}|`)) lastGood.delete(k);
  for (const l of listeners) l(table);
}

/** Derived caches (public stats) hook in here. */
export function onInvalidate(fn: (table?: string) => void): void {
  listeners.add(fn);
}

/** Tests: forget everything (including generations' effect on in-flight reads). */
export function resetReadCache(): void {
  invalidateTable();
}
