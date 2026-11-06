// Tiny fake Airtable REST server for e2e (the real base is never touched).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { F, T } from "../../src/lib/airtable/schema.ts";
import { MOCK_PORT, seedRows } from "./e2e-data.ts";

const legacy = JSON.parse(readFileSync(new URL("../kep/fixtures/legacy.json", import.meta.url), "utf8")) as Record<
  string,
  { id: string; f: Record<string, unknown> }[]
>;
const MAP: Record<string, [string, Record<string, string>]> = {
  paroki: [T.paroki, F.paroki],
  penyelenggaraKep: [T.penyelenggaraKep, F.penyelenggaraKep],
  events: [T.events, F.events],
  eventKep: [T.eventKep, F.eventKep],
  teamUmat: [T.teamUmat, F.teamUmat],
  pendaftaranEvents: [T.pendaftaranEvents, F.pendaftaranEvents],
};
const tables: Record<string, { id: string; fields: Record<string, unknown> }[]> = {};
for (const [k, [tid, fmap]] of Object.entries(MAP)) {
  tables[tid] = legacy[k].map((r) => ({
    id: r.id,
    fields: Object.fromEntries(Object.entries(r.f).map(([n, v]) => [fmap[n], v])),
  }));
}
for (const ev of tables[T.events]) ev.fields["fldhpu7dbyYUETwuY"] = `2601-${ev.fields[F.events.namaAcara]}`;

// e2e-only rows (parishes, KEPs, pertemuan, peserta, accounts). Added on top of the legacy fixture.
const initial: typeof tables = {};
const seed = seedRows();
for (const [tid, rows] of Object.entries(seed)) tables[tid] = [...(tables[tid] ?? []), ...rows];
for (const [tid, rows] of Object.entries(tables)) initial[tid] = structuredClone(rows);

const port = Number(process.env.MOCK_AIRTABLE_PORT || MOCK_PORT);
let nextId = 1;
const readJson = (req: IncomingMessage) =>
  new Promise<{ records?: { id?: string; fields?: Record<string, unknown> }[] }>((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b ? JSON.parse(b) : {}));
  });
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/");
  if (url.pathname === "/__reset" && req.method === "POST") {
    for (const k of Object.keys(tables)) tables[k] = structuredClone(initial[k] ?? []);
    return send(res, 200, { ok: true });
  }
  const table = parts[2];
  const id = parts[3];
  const rows = table ? (tables[table] ??= []) : [];
  if (req.method === "GET") {
    if (id) {
      const r = rows.find((x) => x.id === id);
      return r ? send(res, 200, r) : send(res, 404, { error: "NOT_FOUND" });
    }
    return send(res, 200, { records: rows });
  }
  if (req.method === "PATCH" || req.method === "POST") {
    const body = await readJson(req);
    const out = [];
    for (const rec of body.records ?? []) {
      if (req.method === "POST") {
        const created = { id: `recMOCK${String(nextId++).padStart(10, "0")}`, fields: { ...rec.fields } };
        rows.push(created);
        out.push(created);
      } else {
        const r = rows.find((x) => x.id === rec.id);
        if (!r) return send(res, 404, { error: "NOT_FOUND" });
        for (const [k, v] of Object.entries(rec.fields ?? {})) {
          if (v === null) delete r.fields[k];
          else r.fields[k] = v;
        }
        out.push(r);
      }
    }
    return send(res, 200, { records: out });
  }
  send(res, 405, { error: "METHOD" });
}).listen(port, "127.0.0.1");
