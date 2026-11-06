// Production configuration gate. Deliberately free of `server-only` and Node-only imports so src/proxy.ts can use it.
//
// Behaviour (documented in docs/ops/runbook.md):
// - NODE_ENV=production (Vercel production AND preview) with any problem below: src/proxy.ts answers EVERY request
//   with 503 and logs the variable NAMES (never values); src/instrumentation.ts logs the same at server start.
// - Independently, the shared-store code paths fail closed on their own (defence in depth): the rate limiter
//   denies (429), the session denylist reports every session as revoked (401) and a logout cannot be recorded.
//   They never fall back to per-process memory in production.
// - AIRTABLE_API_URL is ignored by the Airtable client in production (the token is only ever sent to Airtable).
// - Development and tests keep the in-memory fallback and the API URL override.
//
// KEP_E2E_MODE=1 relaxes ONLY the Upstash requirement, the AIRTABLE_API_URL override and http://localhost origins,
// so the Playwright suite can run a production build against a local fake Airtable. It takes effect only when ALL
// hold: AIRTABLE_API_URL points at a loopback host (localhost / 127.0.0.1 / ::1), APP_BASE_URL (if set) is loopback
// too, and none of VERCEL / VERCEL_ENV / VERCEL_URL is present. Otherwise it is ignored AND, in production, it is a
// configuration problem (the proxy answers 503): the token can never be sent off-box and the shared limits can
// never silently become per-process.

type Env = Record<string, string | undefined>;

export const AIRTABLE_DEFAULT_API_URL = "https://api.airtable.com/v0";

export const isProduction = (env: Env = process.env) => env.NODE_ENV === "production";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** Plain loopback http(s) URL: no userinfo (http://localhost@evil.example is refused), host must be loopback. */
function isLoopbackUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}
const onVercel = (env: Env) => !!(env.VERCEL || env.VERCEL_ENV || env.VERCEL_URL);

/** The local e2e escape hatch: only with a loopback Airtable (and app) URL and never with any Vercel variable. */
export const e2eRelaxed = (env: Env = process.env) =>
  env.KEP_E2E_MODE === "1" && !onVercel(env) && isLoopbackUrl(env.AIRTABLE_API_URL) && (!env.APP_BASE_URL || isLoopbackUrl(env.APP_BASE_URL));

/** Strict production: the in-memory store and the Airtable URL override are forbidden. */
export const strictProduction = (env: Env = process.env) => isProduction(env) && !e2eRelaxed(env);

export const upstashConfigured = (env: Env = process.env) => !!env.UPSTASH_REDIS_REST_URL && !!env.UPSTASH_REDIS_REST_TOKEN;

/** May the rate limiter / session denylist use per-process memory? Only outside strict production. */
export const memoryStoreAllowed = (env: Env = process.env) => !strictProduction(env);

/** Airtable API root: the override only outside strict production. */
export function airtableApiUrl(env: Env = process.env): string {
  const raw = strictProduction(env) ? "" : env.AIRTABLE_API_URL;
  return (raw || AIRTABLE_DEFAULT_API_URL).replace(/\/+$/, "");
}

function originProblem(name: string, raw: string | undefined, env: Env): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `${name} bukan URL yang valid`;
  }
  const local = LOOPBACK.has(u.hostname);
  if (u.protocol !== "https:" && !(e2eRelaxed(env) && local && u.protocol === "http:")) return `${name} harus https`;
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) {
    return `${name} harus berupa origin saja (tanpa path)`;
  }
  return null;
}

/**
 * Names of missing/invalid production settings (never their values). Empty outside production.
 */
export function productionConfigProblems(env: Env = process.env): string[] {
  if (!isProduction(env)) return [];
  const p: string[] = [];
  if (env.KEP_E2E_MODE && !e2eRelaxed(env))
    p.push("KEP_E2E_MODE (hanya untuk uji lokal: wajib AIRTABLE_API_URL/APP_BASE_URL loopback dan tanpa variabel VERCEL*; hapus di server)");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) p.push("SESSION_SECRET (wajib, >= 32 karakter)");
  if (!env.MFA_ENC_KEY || !/^[A-Za-z0-9+/]{43}=$/.test(env.MFA_ENC_KEY)) p.push("MFA_ENC_KEY (wajib, base64 dari 32 byte)");
  if (!env.REG_TOKEN_SECRET || new TextEncoder().encode(env.REG_TOKEN_SECRET).length < 32) p.push("REG_TOKEN_SECRET (wajib, >= 32 byte)");
  if (!env.AIRTABLE_TOKEN) p.push("AIRTABLE_TOKEN (wajib)");
  if (!e2eRelaxed(env) && env.AIRTABLE_BASE_ID && !/^app[A-Za-z0-9]{14}$/.test(env.AIRTABLE_BASE_ID)) p.push("AIRTABLE_BASE_ID (format tidak valid)");
  if (!e2eRelaxed(env) && env.AIRTABLE_API_URL) p.push("AIRTABLE_API_URL (tidak boleh diisi di produksi)");
  if (!env.APP_BASE_URL) p.push("APP_BASE_URL (wajib)");
  const a = originProblem("APP_BASE_URL", env.APP_BASE_URL, env);
  if (a) p.push(a);
  const g = originProblem("GOOGLE_REDIRECT_BASE", env.GOOGLE_REDIRECT_BASE, env);
  if (g) p.push(g);
  if (!a && !g && env.APP_BASE_URL && env.GOOGLE_REDIRECT_BASE && new URL(env.APP_BASE_URL).origin !== new URL(env.GOOGLE_REDIRECT_BASE).origin) {
    p.push("GOOGLE_REDIRECT_BASE harus sama dengan APP_BASE_URL");
  }
  if (!e2eRelaxed(env)) {
    if (!upstashConfigured(env)) p.push("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (wajib di produksi)");
    else if (!/^https:\/\//.test(env.UPSTASH_REDIS_REST_URL!)) p.push("UPSTASH_REDIS_REST_URL harus https");
  }
  return p;
}

let logged = false;
/** Logs the problem list once per process (names only). Returns the problems. */
export function reportProductionConfig(env: Env = process.env): string[] {
  const p = productionConfigProblems(env);
  if (p.length && !logged) {
    logged = true;
    console.error(`[konfigurasi] Aplikasi menolak melayani (503): ${p.join("; ")}`);
  }
  return p;
}
