import "server-only";

const ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;

/**
 * Server-side Cloudflare Turnstile check. FAILS CLOSED: a missing secret/token, a non-200, a network error
 * or a timeout all count as "not human". The secret never leaves the server.
 */
export async function verifyTurnstile(token: unknown, remoteIp?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret || typeof token !== "string" || token.length === 0 || token.length > 4096) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const out = (await res.json()) as { success?: unknown };
    return out.success === true;
  } catch {
    return false;
  }
}
