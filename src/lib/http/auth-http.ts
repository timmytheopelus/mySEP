import "server-only";
import { HttpError } from "@/lib/http/errors";

/** Shared by every state-changing auth route (Task 7 reuses it). */

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const serverError = () => json({ error: "Terjadi kesalahan. Coba lagi nanti." }, 500);

export function tooMany(retryAfter: number): Response {
  const res = json({ error: "Terlalu banyak percobaan. Coba lagi nanti." }, 429);
  res.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfter))));
  return res;
}

/**
 * CSRF / login-CSRF guard: JSON content type only (multipart for the Excel import routes), and a same-origin
 * browser signal is required (Sec-Fetch-Site and/or Origin must be present, and any present one must be
 * same-origin). Returns a Response to send back, or null when the request may proceed.
 *
 * Behind the real host: `new URL(req.url).origin` is the host the platform received (Vercel passes the public
 * Host, so a custom domain and each *.vercel.app preview URL each compare against themselves). A browser on
 * https://kep.example.org posting to https://kep.example.org passes; a page on any other origin, including a
 * preview URL posting to production, is refused. If a reverse proxy in front of the app ever rewrites Host,
 * this check refuses every POST (fails closed) until the proxy forwards the public Host.
 */
export function guardPost(req: Request, opts: { multipart?: boolean } = {}): Response | null {
  const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== (opts.multipart ? "multipart/form-data" : "application/json")) return json({ error: "Tipe konten tidak didukung" }, 415);
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  if (site === null && origin === null) return json({ error: "Permintaan ditolak" }, 403);
  if (site !== null && site !== "same-origin") return json({ error: "Permintaan ditolak" }, 403);
  if (origin !== null && origin !== new URL(req.url).origin) return json({ error: "Permintaan ditolak" }, 403);
  return null;
}

/**
 * Client IP for rate limiting. TRUST ASSUMPTION: this is only correct on Vercel, whose edge overwrites
 * X-Real-IP / X-Forwarded-For with the real client address (a client cannot spoof them there). On any other
 * host (self-hosted `next start`, another proxy) these headers are client-controlled unless the proxy in front
 * strips and re-sets them, so per-IP limits could be bypassed by rotating the header. Per-account, per-email and
 * per-link limits do not depend on it. See docs/ops/runbook.md.
 */
export function clientIpFromHeaders(h: Headers): string {
  return h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function clientIp(req: Request): string {
  return clientIpFromHeaders(req.headers);
}

export function withCookies(res: Response, cookies: string[]): Response {
  for (const c of cookies) res.headers.append("Set-Cookie", c);
  return res;
}

/** JSON object body or HttpError(400); unknown shapes (arrays, primitives) are refused. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400);
}
