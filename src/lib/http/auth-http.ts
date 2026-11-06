import "server-only";

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
 * CSRF / login-CSRF guard: JSON content type only, and a same-origin browser signal is required
 * (Sec-Fetch-Site and/or Origin must be present, and any present one must be same-origin).
 * Returns a Response to send back, or null when the request may proceed.
 */
export function guardPost(req: Request): Response | null {
  const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") return json({ error: "Tipe konten tidak didukung" }, 415);
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  if (site === null && origin === null) return json({ error: "Permintaan ditolak" }, 403);
  if (site !== null && site !== "same-origin") return json({ error: "Permintaan ditolak" }, 403);
  if (origin !== null && origin !== new URL(req.url).origin) return json({ error: "Permintaan ditolak" }, 403);
  return null;
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-real-ip")?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function withCookies(res: Response, cookies: string[]): Response {
  for (const c of cookies) res.headers.append("Set-Cookie", c);
  return res;
}
