import "server-only";
import { createHash } from "node:crypto";
import { memoryStoreAllowed } from "@/lib/config/prodEnv";

/**
 * Fixed-window counter shared by auth routes (Task 13 reuses it).
 * - UPSTASH_REDIS_REST_URL/TOKEN set: atomic INCR in Redis, shared by all instances. Any Upstash error
 *   FAILS CLOSED (request denied) unless the caller opts out with failClosed:false.
 * - Otherwise, in development/tests only: in-memory Map (per process).
 * - Production (NODE_ENV=production) without Upstash NEVER uses memory: every limit is denied (429) and the
 *   session denylist reports every session as revoked (401). src/proxy.ts answers 503 first in that case
 *   (src/lib/config/prodEnv.ts); this is the second line of defence.
 * - Upstash outage: limits fail closed (429) and, because the denylist read fails closed, ALL sessions are
 *   treated as revoked (401) until Upstash answers again. Documented in docs/ops/runbook.md.
 * The AkunKEP failed-login counter is a durable but best-effort (non-atomic) record on top of this.
 */
export type LimitResult = { ok: boolean; retryAfter: number };

const mem = new Map<string, { count: number; resetAt: number }>();
const UPSTASH_TIMEOUT_MS = 3000;
const FAIL_CLOSED_RETRY_S = 30;

const revoked = new Map<string, number>();

type Cmd = (string | number)[];
type Reply = { result?: unknown; error?: unknown };

/** One Upstash REST pipeline call. Throws on transport/HTTP errors and on a body that is not one reply per command. */
async function pipeline(url: string, token: string, cmds: Cmd[]): Promise<Reply[]> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const out: unknown = await res.json();
  if (!Array.isArray(out) || out.length !== cmds.length || !out.every((r) => r !== null && typeof r === "object")) {
    throw new Error("upstash bad response");
  }
  return out as Reply[];
}
const failed = (r: Reply | undefined) => !r || (r.error !== undefined && r.error !== null);

let warned = false;
/** Production without Upstash: never memory. Logged once per process (no values). */
function noSharedStore(): boolean {
  if (memoryStoreAllowed()) return false;
  if (!warned) {
    warned = true;
    console.error("[ratelimit] UPSTASH_REDIS_REST_URL/TOKEN missing in production: limits and session checks fail closed");
  }
  return true;
}

export function resetRateLimitMemory(): void {
  mem.clear();
  revoked.clear();
  memJson.clear();
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
    if (noSharedStore()) return false;
    revoked.set(key, Date.now() + ttl * 1000);
    return true;
  }
  try {
    const [r] = await pipeline(url, token, [["SET", key, "1", "EX", ttl]]);
    return !failed(r) && r.result === "OK";
  } catch {
    return false;
  }
}

/** Fails closed: anything but a well-formed "no such key" answer counts as revoked. */
export async function isKeyRevoked(key: string): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (noSharedStore()) return true;
    const until = revoked.get(key);
    if (until !== undefined && until <= Date.now()) revoked.delete(key);
    return until !== undefined && until > Date.now();
  }
  try {
    const [r] = await pipeline(url, token, [["GET", key]]);
    if (failed(r)) return true;
    return r.result !== null;
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
  const [incr, expire, ttlR] = await pipeline(url, token, [["INCR", key], ["EXPIRE", key, windowS, "NX"], ["TTL", key]]);
  const count = incr.result;
  if (failed(incr) || typeof count !== "number") throw new Error("upstash bad response");
  let ttl = failed(ttlR) ? null : ttlR.result;
  // A key without expiry (TTL -1), or an EXPIRE/TTL that errored, would count forever: repair it with a plain
  // EXPIRE. If the repair fails too, the caller fails closed.
  if (failed(expire) || typeof ttl !== "number" || ttl === -1) {
    const [fix] = await pipeline(url, token, [["EXPIRE", key, windowS]]);
    if (failed(fix) || fix.result !== 1) throw new Error("upstash expire failed");
    ttl = windowS;
  }
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
  if (!url || !token) {
    // Production without a shared store: deny regardless of failClosed (never a per-process counter).
    if (noSharedStore()) return { ok: false, retryAfter: FAIL_CLOSED_RETRY_S };
    return memoryLimit(key, limit, windowS);
  }
  try {
    return await upstashLimit(url, token, key, limit, windowS);
  } catch {
    return (opts.failClosed ?? true) ? { ok: false, retryAfter: FAIL_CLOSED_RETRY_S } : { ok: true, retryAfter: 0 };
  }
}

// ---------------------------------------------------------------------------------------------
// Small shared JSON values (public landing stats): Upstash when configured, per-process memory in dev/tests,
// nothing in production without Upstash. Best effort: errors read as "absent" and writes report false.
// ---------------------------------------------------------------------------------------------
const memJson = new Map<string, { v: string; until: number }>();

export async function sharedGetJson<T>(key: string): Promise<T | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  let raw: unknown = null;
  if (!url || !token) {
    if (!memoryStoreAllowed()) return null;
    const e = memJson.get(key);
    raw = e && e.until > Date.now() ? e.v : null;
  } else {
    try {
      const [r] = await pipeline(url, token, [["GET", key]]);
      raw = failed(r) ? null : r.result;
    } catch {
      return null;
    }
  }
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function sharedSetJson(key: string, value: unknown, ttlS: number): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const v = JSON.stringify(value);
  const ttl = Math.max(1, Math.ceil(ttlS));
  if (!url || !token) {
    if (!memoryStoreAllowed()) return false;
    memJson.set(key, { v, until: Date.now() + ttl * 1000 });
    return true;
  }
  try {
    const [r] = await pipeline(url, token, [["SET", key, v, "EX", ttl]]);
    return !failed(r) && r.result === "OK";
  } catch {
    return false;
  }
}

export function resetSharedJsonMemory(): void {
  memJson.clear();
}
