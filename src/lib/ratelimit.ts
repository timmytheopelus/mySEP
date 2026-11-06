import "server-only";
import { createHash } from "node:crypto";

/**
 * Fixed-window counter shared by auth routes (Task 13 reuses it).
 * - UPSTASH_REDIS_REST_URL/TOKEN set: atomic INCR in Redis, shared by all instances. Any Upstash error
 *   FAILS CLOSED (request denied) unless the caller opts out with failClosed:false.
 * - Otherwise: in-memory Map. Per-process only, so in serverless it is a weak best-effort fallback;
 *   production must configure Upstash.
 * The AkunKEP failed-login counter is a durable but best-effort (non-atomic) record on top of this.
 */
export type LimitResult = { ok: boolean; retryAfter: number };

const mem = new Map<string, { count: number; resetAt: number }>();
const UPSTASH_TIMEOUT_MS = 3000;
const FAIL_CLOSED_RETRY_S = 30;

const revoked = new Map<string, number>();

export function resetRateLimitMemory(): void {
  mem.clear();
  revoked.clear();
}

/**
 * Revocation denylist (server-side logout) on the same shared store as the limiter: Upstash when configured
 * (SET key EX ttl / GET), else per-process memory. An Upstash error FAILS CLOSED on read (treated as revoked)
 * and is reported to the caller on write.
 */
export async function revokeKey(key: string, ttlS: number): Promise<boolean> {
  const ttl = Math.max(1, Math.ceil(ttlS));
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    revoked.set(key, Date.now() + ttl * 1000);
    return true;
  }
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", key, "1", "EX", ttl]]),
      signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function isKeyRevoked(key: string): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const until = revoked.get(key);
    if (until !== undefined && until <= Date.now()) revoked.delete(key);
    return until !== undefined && until > Date.now();
  }
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["GET", key]]),
      signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
    });
    if (!res.ok) return true;
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    if (out[0]?.error) return true;
    return out[0]?.result !== null && out[0]?.result !== undefined;
  } catch {
    return true;
  }
}

/** Hash identifiers (emails, IPs) so no personal data is used as a Redis key. */
export const limitKey = (...parts: string[]) =>
  "kep:rl:" + createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);

function memoryLimit(key: string, limit: number, windowS: number): LimitResult {
  const now = Date.now();
  if (mem.size > 10_000) for (const [k, v] of mem) if (v.resetAt <= now) mem.delete(k);
  let e = mem.get(key);
  if (!e || e.resetAt <= now) {
    e = { count: 0, resetAt: now + windowS * 1000 };
    mem.set(key, e);
  }
  e.count++;
  return { ok: e.count <= limit, retryAfter: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) };
}

async function upstashLimit(url: string, token: string, key: string, limit: number, windowS: number): Promise<LimitResult> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["INCR", key], ["EXPIRE", key, windowS, "NX"], ["TTL", key]]),
    signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const out = (await res.json()) as { result?: unknown; error?: string }[];
  const count = out[0]?.result;
  const ttl = out[2]?.result;
  if (typeof count !== "number" || out[0]?.error) throw new Error("upstash bad response");
  return { ok: count <= limit, retryAfter: typeof ttl === "number" && ttl > 0 ? ttl : windowS };
}

/** Counts one attempt against `key` and says whether it is within `limit` per `windowS` seconds. */
export async function rateLimit(
  key: string,
  limit: number,
  windowS: number,
  opts: { failClosed?: boolean } = {},
): Promise<LimitResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return memoryLimit(key, limit, windowS);
  try {
    return await upstashLimit(url, token, key, limit, windowS);
  } catch {
    return (opts.failClosed ?? true) ? { ok: false, retryAfter: FAIL_CLOSED_RETRY_S } : { ok: true, retryAfter: 0 };
  }
}
