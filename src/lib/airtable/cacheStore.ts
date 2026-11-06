import type { AtRecord } from "@/lib/airtable/client";
import { T } from "@/lib/airtable/schema";

/** State of the shared read cache (no client import, so test helpers can reset it). Logic: ./cache.ts */
export type Entry = { at: number; gen: number; p: Promise<AtRecord[]>; failedAt?: number; inflight?: boolean };
type State = { tableGen: Map<string, number>; tableCache: Map<string, Entry>; lastGood: Map<string, { rows: AtRecord[]; at: number }>; listeners: Set<(table?: string) => void> };
// One state per PROCESS, not per module instance: the production build bundles route handlers and server
// components separately (two copies of this module in one process), and an API write must invalidate what the
// pages read. globalThis + Symbol.for is shared by both copies.
const KEY = Symbol.for("kep.airtable.readCache.v2");
const G = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (G[KEY] ??= { tableGen: new Map(), tableCache: new Map(), lastGood: new Map(), listeners: new Set() });
export const tableGen = state.tableGen;
export const genOf = (t: string) => tableGen.get(t) ?? 0;
export const tableCache = state.tableCache;
export const lastGood = state.lastGood;
export const listeners = state.listeners;

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
