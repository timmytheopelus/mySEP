// Tiny fake Airtable REST server for e2e (the real base is never touched).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { F, T } from "../../src/lib/airtable/schema.ts";

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

const port = Number(process.env.MOCK_AIRTABLE_PORT || 4010);
createServer((req, res) => {
  const table = new URL(req.url ?? "/", "http://x").pathname.split("/")[2];
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ records: tables[table] ?? [] }));
}).listen(port, "127.0.0.1");
