import "server-only";
import { airtableApiUrl } from "@/lib/config/prodEnv";
import { AirtableError } from "./errors";
import { READ_ALLOWED, pickAllowed } from "./schema";

export type AtRecord = { id: string; fields: Record<string, unknown> };

const DEFAULT_BASE_ID = "appIGR8Duhj3Vsz48";
const MAX_RETRIES = 3;
const CHUNK = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** AIRTABLE_API_URL (local fake for tests/e2e) is ignored in production: the token only ever goes to Airtable. */
function baseUrl(): string {
  return `${airtableApiUrl()}/${process.env.AIRTABLE_BASE_ID || DEFAULT_BASE_ID}`;
}

function readAllow(tableId: string): Set<string> {
  const allow = READ_ALLOWED[tableId];
  if (!allow) throw new Error(`No read allowlist for table ${tableId}`); // fail closed
  return allow;
}

/** Drops every field outside the read allowlist (defence in depth; list requests ask for allowed fields only). */
function strip(tableId: string, rec: AtRecord): AtRecord {
  const allow = readAllow(tableId);
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec?.fields ?? {})) if (allow.has(k)) fields[k] = v;
  return { ...rec, fields };
}

/**
 * Error text safe for logs: Airtable's error type plus its message with quoted parts, e-mail addresses, long
 * digit runs and anything token-like removed (messages can echo submitted values).
 */
export function redactAirtableError(body: unknown): string {
  const e = (body as { error?: unknown } | null)?.error;
  const type = typeof e === "string" ? e : typeof (e as { type?: unknown })?.type === "string" ? (e as { type: string }).type : "";
  const msg = typeof (e as { message?: unknown })?.message === "string" ? (e as { message: string }).message : "";
  const clean = msg
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .replace(/[^\s@]+@[^\s@]+/g, "…")
    .replace(/\+?\d[\d\s-]{5,}\d/g, "…")
    .replace(/\b(pat|key)[A-Za-z0-9.]{8,}/g, "…")
    .slice(0, 200);
  return [type.replace(/[^A-Z0-9_]/g, "").slice(0, 60), clean].filter(Boolean).join(": ");
}

// ---------------------------------------------------------------------------------------------
// Process-wide throttle. Airtable allows 5 requests/s per BASE (shared with every other BPK integration) and
// answers excess with 429 plus a ~30 s penalty for the whole base. Every request of this process goes through
// one sliding-window limiter (AIRTABLE_MAX_RPS, default 4, never above 5) with a FIFO queue; a full queue fails fast with
// a transient 503 instead of piling up. A 429 pauses the bucket for Retry-After (default AIRTABLE_429_PAUSE_MS,
// 30 s); a request waits at most AIRTABLE_MAX_WAIT_MS (default 30 s, queue + pause + retries) and then fails
// with a transient error (HTTP 503 + Retry-After at the route). Per process only: N warm instances can still
// reach N x rate, see docs/ops/runbook.md.
// ---------------------------------------------------------------------------------------------

import { airtableMaxWaitMs, routeDeadline } from "./deadline";
export { AirtableError, isAirtableNotFound, isTransientAirtableError } from "./errors";

const envNum = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};
/** Requests per second, clamped to (0, 5]. */
export const maxRps = () => Math.min(5, envNum("AIRTABLE_MAX_RPS", 4));
const maxQueue = () => Math.floor(envNum("AIRTABLE_QUEUE_MAX", 40));
const maxWaitMs = () => airtableMaxWaitMs();
const pauseMs = () => envNum("AIRTABLE_429_PAUSE_MS", 30_000);

/** Sliding window: at most maxRps() request starts in any 1000 ms (a plain bucket could allow 2x in a window). */
type Waiter = { resolve: () => void; reject: (e: unknown) => void; deadline: number };
type Throttle = { bucket: { starts: number[]; pausedUntil: number }; waiters: Waiter[]; pumping: ReturnType<typeof setTimeout> | null };
// Process-wide (not per module copy: route handlers and server components are bundled separately in production).
const TKEY = Symbol.for("kep.airtable.throttle.v1");
const TG = globalThis as unknown as Record<symbol, Throttle | undefined>;
const T_ = (TG[TKEY] ??= { bucket: { starts: [], pausedUntil: 0 }, waiters: [], pumping: null });
const bucket = T_.bucket;
const waiters = T_.waiters;

const busy = (retryAfterS: number) => new AirtableError("Airtable request failed: busy (local queue full or wait budget spent)", 503, true, Math.max(1, Math.ceil(retryAfterS)));

function pump() {
  T_.pumping = null;
  const now = Date.now();
  const rps = maxRps();
  while (bucket.starts.length && now - bucket.starts[0] >= 1000) bucket.starts.shift();
  while (waiters.length) {
    const w = waiters[0];
    if (now > w.deadline) {
      waiters.shift();
      w.reject(busy((bucket.pausedUntil - now) / 1000));
      continue;
    }
    if (now < bucket.pausedUntil || bucket.starts.length >= rps) break;
    bucket.starts.push(now);
    waiters.shift();
    w.resolve();
  }
  if (waiters.length) {
    const wait = now < bucket.pausedUntil ? bucket.pausedUntil - now : bucket.starts[0] + 1000 - now;
    T_.pumping = setTimeout(pump, Math.max(1, Math.min(wait, waiters[0].deadline - now + 1)));
  }
}

/** Waits for a request slot; rejects with a transient 503 when the queue is full or the deadline would pass. */
function acquire(deadline: number): Promise<void> {
  const now = Date.now();
  if (bucket.pausedUntil > deadline) return Promise.reject(busy((bucket.pausedUntil - now) / 1000));
  if (waiters.length >= maxQueue()) return Promise.reject(busy(Math.max(1, waiters.length / maxRps())));
  return new Promise<void>((resolve, reject) => {
    waiters.push({ resolve, reject, deadline });
    if (!T_.pumping) pump();
  });
}

/** Test hook: empties the bucket state (pending waiters are rejected). */
export function resetAirtableThrottle(): void {
  if (T_.pumping) clearTimeout(T_.pumping);
  T_.pumping = null;
  for (const w of waiters.splice(0)) w.reject(busy(1));
  bucket.starts = [];
  bucket.pausedUntil = 0;
}
/** Observability/tests: current queue depth and pause. */
export const throttleState = () => ({ queued: waiters.length, pausedForMs: Math.max(0, bucket.pausedUntil - Date.now()) });

function retryAfterMs(res: Response): number {
  const h = res.headers.get("retry-after");
  const n = h === null ? NaN : Number(h);
  return Number.isFinite(n) && n >= 0 ? Math.min(n * 1000, 120_000) : pauseMs();
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error("AIRTABLE_TOKEN is not set");
  const backoff = envNum("AIRTABLE_BACKOFF_MS", 500);
  const isRead = !init.method || init.method === "GET";
  const deadline = Math.min(Date.now() + maxWaitMs(), routeDeadline()); // never wait past the route budget
  if (Date.now() >= deadline) throw busy(1);
  for (let attempt = 0; ; attempt++) {
    await acquire(deadline);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch {
      // Network error: a read is retried once; a write may or may not have landed, so it is never repeated here.
      if (isRead && attempt < 1 && Date.now() + backoff < deadline) {
        await sleep(backoff);
        continue;
      }
      throw new AirtableError("Airtable request failed: network", 0, true, 5);
    }
    if (res.status === 429) {
      // Not processed by Airtable: safe to repeat, reads and writes alike. Pause the whole process meanwhile.
      const wait = retryAfterMs(res);
      bucket.pausedUntil = Math.max(bucket.pausedUntil, Date.now() + wait);
      res.body?.cancel().catch(() => {});
      if (attempt < MAX_RETRIES && bucket.pausedUntil <= deadline) continue;
      throw new AirtableError("Airtable request failed: HTTP 429", 429, true, Math.ceil(Math.max(1000, bucket.pausedUntil - Date.now()) / 1000));
    }
    if (res.status >= 500 && isRead && attempt < 1 && Date.now() + backoff < deadline) {
      res.body?.cancel().catch(() => {});
      await sleep(backoff);
      continue;
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = redactAirtableError(await res.json());
      } catch {
        /* no JSON body */
      }
      const transient = res.status >= 500;
      throw new AirtableError(`Airtable request failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`, res.status, transient, transient ? 5 : undefined);
    }
    return (await res.json()) as T;
  }
}

export type ListOptions = {
  fields: string[];
  filterByFormula?: string;
  sort?: { field: string; direction: "asc" | "desc" }[];
  maxRecords?: number;
};

export async function listRecords(tableId: string, opts: ListOptions): Promise<AtRecord[]> {
  const allow = readAllow(tableId);
  const bad = opts.fields.filter((f) => !allow.has(f));
  if (bad.length) throw new Error(`Field(s) outside the read allowlist for ${tableId}: ${bad.join(", ")}`);
  const out: AtRecord[] = [];
  let offset: string | undefined;
  do {
    const p = new URLSearchParams({ returnFieldsByFieldId: "true" });
    for (const f of opts.fields) p.append("fields[]", f);
    if (opts.filterByFormula) p.set("filterByFormula", opts.filterByFormula);
    opts.sort?.forEach((s, i) => {
      p.set(`sort[${i}][field]`, s.field);
      p.set(`sort[${i}][direction]`, s.direction);
    });
    if (opts.maxRecords) p.set("maxRecords", String(opts.maxRecords));
    if (offset) p.set("offset", offset);
    const page = await request<{ records: AtRecord[]; offset?: string }>(`${baseUrl()}/${tableId}?${p}`);
    out.push(...page.records.map((r) => strip(tableId, r)));
    offset = page.offset;
  } while (offset);
  return out;
}

/** Airtable has no field filter for single-record reads: the response is stripped to the read allowlist. */
export async function getRecord(tableId: string, id: string): Promise<AtRecord> {
  readAllow(tableId);
  const rec = await request<AtRecord>(`${baseUrl()}/${tableId}/${encodeURIComponent(id)}?returnFieldsByFieldId=true`);
  return strip(tableId, rec);
}

async function writeChunks<I>(
  method: "POST" | "PATCH",
  tableId: string,
  items: I[],
  toRecord: (i: I) => unknown,
): Promise<AtRecord[]> {
  const out: AtRecord[] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    const body = { records: items.slice(i, i + CHUNK).map(toRecord), returnFieldsByFieldId: true };
    const res = await request<{ records: AtRecord[] }>(`${baseUrl()}/${tableId}`, {
      method,
      body: JSON.stringify(body),
    });
    out.push(...res.records.map((r) => strip(tableId, r)));
  }
  return out;
}

/** `extra` = restricted field IDs this call may write (see schema RESTRICTED); omit for request-derived data. */
export function createRecords(tableId: string, rows: Record<string, unknown>[], extra?: Set<string>): Promise<AtRecord[]> {
  return writeChunks("POST", tableId, rows, (fields) => ({ fields: pickAllowed(tableId, fields, extra) }));
}

export function updateRecords(
  tableId: string,
  rows: { id: string; fields: Record<string, unknown> }[],
  extra?: Set<string>,
): Promise<AtRecord[]> {
  return writeChunks("PATCH", tableId, rows, (r) => ({ id: r.id, fields: pickAllowed(tableId, r.fields, extra) }));
}
