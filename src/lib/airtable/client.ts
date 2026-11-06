import "server-only";
import { airtableApiUrl } from "@/lib/config/prodEnv";
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

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error("AIRTABLE_TOKEN is not set");
  const backoff = Number(process.env.AIRTABLE_BACKOFF_MS) || 500;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(backoff * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = redactAirtableError(await res.json());
      } catch {
        /* no JSON body */
      }
      throw new Error(`Airtable request failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
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
