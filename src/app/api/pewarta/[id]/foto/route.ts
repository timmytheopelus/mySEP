import { withAuth } from "@/lib/auth/guard";
import { HttpError } from "@/lib/http/errors";
import { fotoSource } from "@/lib/pewarta/profile";

export const dynamic = "force-dynamic";

const MAX_BYTES = 3 * 1024 * 1024;
const IMG = /^image\/(jpeg|png|webp|gif)$/i;

/** Releases the upstream connection without reading the rest of the body. */
function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}

/** Reads at most `max` bytes; null (and the stream cancelled) as soon as the body grows past it. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * Same-origin photo proxy for logged-in users. The upstream URL is looked up server-side by record id (never
 * taken from the client), restricted to Airtable's attachment domain, fetched without redirects, and never
 * stored: Airtable URLs expire, so the response is cached privately for a short time only. Size is checked
 * from Content-Length before reading and again while streaming (3 MB cap); refused bodies are cancelled.
 */
export const GET = withAuth<{ id: string }>(
  async (_req, { session, params }) => {
    const url = await fotoSource(session, params.id);
    let up: Response;
    try {
      up = await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(8000) });
    } catch {
      throw new HttpError(404);
    }
    const type = up.headers.get("content-type")?.split(";")[0].trim() ?? "";
    const declared = Number(up.headers.get("content-length") ?? "");
    if (!up.ok || !IMG.test(type) || (Number.isFinite(declared) && declared > MAX_BYTES)) {
      discard(up);
      throw new HttpError(404);
    }
    let buf: Uint8Array | null;
    try {
      buf = await readCapped(up, MAX_BYTES);
    } catch {
      throw new HttpError(404);
    }
    if (!buf) throw new HttpError(404);
    return new Response(buf as BodyInit, {
      status: 200,
      headers: { "Content-Type": type.toLowerCase(), "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  },
  { roles: ["SEP", "PIC", "ADMIN"] },
);
