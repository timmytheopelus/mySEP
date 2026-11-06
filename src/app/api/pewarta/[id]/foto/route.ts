import { withAuth } from "@/lib/auth/guard";
import { HttpError } from "@/lib/http/errors";
import { fotoSource } from "@/lib/pewarta/profile";

export const dynamic = "force-dynamic";

const MAX_BYTES = 3 * 1024 * 1024;
const IMG = /^image\/(jpeg|png|webp|gif)$/i;

/**
 * Same-origin photo proxy for logged-in users. The upstream URL is looked up server-side by record id (never
 * taken from the client), restricted to Airtable's attachment domain, fetched without redirects, and never
 * stored: Airtable URLs expire, so the response is cached privately for a short time only.
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
    if (!up.ok || !IMG.test(type)) throw new HttpError(404);
    const buf = await up.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new HttpError(404);
    return new Response(buf, {
      status: 200,
      headers: { "Content-Type": type.toLowerCase(), "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  },
  { roles: ["SEP", "PIC", "ADMIN"] },
);
