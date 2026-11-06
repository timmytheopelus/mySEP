import "server-only";
import { listRecords } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { assertKepInScope } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { HttpError } from "@/lib/http/errors";
import { json } from "@/lib/http/auth-http";
import { MAX_FILE_BYTES, ImportFileError, fileHash, parseImport } from "@/lib/kep/import";
import { RegistrationClosedError, resolveOpenKep } from "@/lib/kep/registration";

const MULTIPART_OVERHEAD = 64 * 1024;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const tooBig = () => new HttpError(413, "Berkas terlalu besar (maksimal 2 MB)");

/** Reads the body with a hard cap (Content-Length is checked first, then the stream is cut off at the cap). */
async function readCapped(req: Request): Promise<Buffer> {
  const cap = MAX_FILE_BYTES + MULTIPART_OVERHEAD;
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > cap)) throw tooBig();
  if (!req.body) throw new HttpError(400);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The uploaded "file" part of a multipart request, size capped before and while reading. */
export async function readUpload(req: Request): Promise<{ buf: Buffer; sha256: string }> {
  const raw = await readCapped(req);
  let fd: FormData;
  try {
    fd = await new Request(req.url, { method: "POST", headers: { "content-type": req.headers.get("content-type") ?? "" }, body: new Uint8Array(raw) }).formData();
  } catch {
    throw new HttpError(400);
  }
  const f = fd.get("file");
  if (!(f instanceof Blob)) throw new HttpError(400, "Berkas belum dipilih");
  if (f.size > MAX_FILE_BYTES) throw tooBig();
  const buf = Buffer.from(await f.arrayBuffer());
  return { buf, sha256: fileHash(buf) };
}

/** PIC scope (cross-parish 404) plus "KEP must be Disetujui" (409). Returns the Events id. */
export async function importTarget(session: Session, kepId: string): Promise<string> {
  const { eventKep } = await assertKepInScope(session, kepId);
  const eventId = ids(eventKep.fields[F.eventKep.events])[0];
  if (!eventId) throw new HttpError(409, "KEP belum memiliki acara");
  try {
    await resolveOpenKep(eventId);
  } catch (e) {
    if (e instanceof RegistrationClosedError) throw new HttpError(409, "Pendaftaran belum dibuka: KEP belum disetujui SEP.");
    throw e;
  }
  return eventId;
}

export async function parokiLookup(): Promise<{ byName: Map<string, string>; names: string[] }> {
  const rows = await listRecords(T.paroki, { fields: [F.paroki.nama] });
  const byName = new Map<string, string>();
  const names: string[] = [];
  for (const r of rows) {
    const n = typeof r.fields[F.paroki.nama] === "string" ? (r.fields[F.paroki.nama] as string).trim() : "";
    if (n) {
      byName.set(n.toLowerCase(), r.id);
      names.push(n);
    }
  }
  return { byName, names: names.sort((a, b) => a.localeCompare(b)) };
}

/** Upload -> parse. File problems become 413/422 responses. */
export async function parseUpload(req: Request) {
  const up = await readUpload(req);
  const { byName } = await parokiLookup();
  try {
    return { ...up, parsed: await parseImport(up.buf, { parokiByName: byName }) };
  } catch (e) {
    if (e instanceof ImportFileError) throw new HttpError(e.status, e.message);
    throw e;
  }
}
export { json };
