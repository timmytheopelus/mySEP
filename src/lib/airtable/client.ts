import "server-only";
import { pickAllowed } from "./schema";

export type AtRecord = { id: string; fields: Record<string, unknown> };

const DEFAULT_API_URL = "https://api.airtable.com/v0";
const DEFAULT_BASE_ID = "appIGR8Duhj3Vsz48";
const MAX_RETRIES = 3;
const CHUNK = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseUrl(): string {
  const api = (process.env.AIRTABLE_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  return `${api}/${process.env.AIRTABLE_BASE_ID || DEFAULT_BASE_ID}`;
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
    if (!res.ok) throw new Error(`Airtable request failed: HTTP ${res.status}`);
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
    out.push(...page.records);
    offset = page.offset;
  } while (offset);
  return out;
}

export async function getRecord(tableId: string, id: string): Promise<AtRecord> {
  return request<AtRecord>(
    `${baseUrl()}/${tableId}/${encodeURIComponent(id)}?returnFieldsByFieldId=true`,
  );
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
    out.push(...res.records);
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
