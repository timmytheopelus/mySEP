import "server-only";
import { getRecord, type AtRecord } from "@/lib/airtable/client";
import { isAirtableNotFound, isTransientAirtableError } from "@/lib/airtable/errors";
import { cachedList } from "@/lib/airtable/cache";
import { EVENT_ID_FIELD, F, T } from "@/lib/airtable/schema";
import { HttpError } from "@/lib/http/errors";
import { errorResponse, guardPost, tooMany, withCookies } from "@/lib/http/auth-http";
import { limitKey, rateLimit } from "@/lib/ratelimit";
import { SESSION_COOKIE, renewSession, sessionCookie, type Role, type Session } from "@/lib/auth/session";

export { HttpError };

const REC_ID = /^rec[A-Za-z0-9]{10,}$/;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function authenticate(req: Request): Promise<{ session: Session; token: string }> {
  const r = await renewSession(req.headers.get("cookie") ?? "");
  if (!r) throw new HttpError(401);
  return r;
}

/** Valid session (cookie, 8 h cap, live account, MFA rules, password-change revocation) or HttpError(401). */
export async function requireSession(req: Request): Promise<Session> {
  return (await authenticate(req)).session;
}

/** HttpError(403) unless the role is allowed; PIC/ADMIN without a paroki are always refused. */
export function requireRole(session: Session, roles: Role[]): void {
  if (!roles.includes(session.role)) throw new HttpError(403);
  if (session.role !== "SEP" && !session.parokiId) throw new HttpError(403);
}

export function scopeFilter(session: Session): { parokiId: string | "ALL" } {
  if (session.role === "SEP") return { parokiId: "ALL" };
  if (!session.parokiId) throw new HttpError(403);
  return { parokiId: session.parokiId };
}

/** One EventKEP read shared by scope checks and the KEP index (about 20 rows). */
export const KEP_FIELDS = [F.eventKep.penyelenggara, F.eventKep.events, F.eventKep.statusPersetujuan, F.eventKep.angkatan, F.eventKep.tanggalMulai, F.eventKep.tanggalSelesai];
const ORG_FIELDS = [F.penyelenggaraKep.paroki];
/** A miss (unknown KEP / event) forces one refresh when the cached map is older than this (new KEP on another instance). */
const MISS_REFRESH_MS = 5_000;

/**
 * Paroki ids per EventKEP id, resolved through its Pengelenggara KEP rows (id based, no formulas). Both reads
 * (about 20 rows each) go through the shared read cache (45 s, single flight); every app write to these tables
 * calls invalidateKepCache(). `maxAgeMs` forces a refresh of an older entry (used once after a miss).
 */
async function kepParokiMap(maxAgeMs?: number): Promise<{ kep: AtRecord[]; parokiOf: Map<string, string[]> }> {
  const o = maxAgeMs === undefined ? {} : { maxAgeMs };
  const [kep, org] = await Promise.all([cachedList(T.eventKep, KEP_FIELDS, undefined, o), cachedList(T.penyelenggaraKep, ORG_FIELDS, undefined, o)]);
  const orgParoki = new Map(org.map((o) => [o.id, ids(o.fields[F.penyelenggaraKep.paroki])]));
  const parokiOf = new Map<string, string[]>();
  for (const k of kep) {
    parokiOf.set(k.id, ids(k.fields[F.eventKep.penyelenggara]).flatMap((o) => orgParoki.get(o) ?? []));
  }
  return { kep, parokiOf };
}

/** The map, refreshed once (if older than MISS_REFRESH_MS) when `found` says the cached one lacks what we need. */
async function kepParokiMapFor(found: (m: Awaited<ReturnType<typeof kepParokiMap>>) => boolean) {
  const m = await kepParokiMap();
  if (found(m)) return m;
  return kepParokiMap(MISS_REFRESH_MS);
}

/** One scope rule for everybody: ALL sees everything; a paroki sees what lists it as organizer. */
export const parokiAllows = (scope: string | "ALL", parokis: string[]) => scope === "ALL" || parokis.includes(scope);

const inScope = (s: Session, parokis: string[]) =>
  s.role === "SEP" || (!!s.parokiId && parokiAllows(s.parokiId, parokis));

/**
 * SEP: any KEP. PIC/ADMIN: only their paroki. Everything else (missing, foreign, malformed): 404.
 * Scope comes from the cached KEP map; `fresh: true` (write decisions that depend on the status) re-reads the
 * EventKEP record itself (1 call) and re-checks scope on it, so a stale cache can never allow a write.
 */
export async function assertKepInScope(
  session: Session,
  eventKepId: string,
  o: { fresh?: boolean } = {},
): Promise<{ eventKep: AtRecord; parokiId: string | null }> {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  if (typeof eventKepId !== "string" || !REC_ID.test(eventKepId)) throw new HttpError(404);
  const m = await kepParokiMapFor((m) => m.kep.some((k) => k.id === eventKepId && inScope(session, m.parokiOf.get(k.id) ?? [])));
  let eventKep = m.kep.find((k) => k.id === eventKepId);
  let parokis = m.parokiOf.get(eventKepId) ?? [];
  if (!eventKep || !inScope(session, parokis)) throw new HttpError(404);
  if (o.fresh) {
    eventKep = await fetchOr404(T.eventKep, eventKepId);
    const org = await cachedList(T.penyelenggaraKep, ORG_FIELDS);
    const orgParoki = new Map(org.map((x) => [x.id, ids(x.fields[F.penyelenggaraKep.paroki])]));
    parokis = ids(eventKep.fields[F.eventKep.penyelenggara]).flatMap((x) => orgParoki.get(x) ?? []);
    if (!inScope(session, parokis)) throw new HttpError(404);
  }
  return { eventKep, parokiId: session.role === "SEP" ? (parokis[0] ?? null) : session.parokiId };
}

/** Resolve the EventKEP behind an Events record id; 404 if it is not a KEP event. */
async function kepOfEvent(session: Session, eventIds: string[]) {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  const { kep, parokiOf } = await kepParokiMapFor((m) => m.kep.some((x) => ids(x.fields[F.eventKep.events]).some((e) => eventIds.includes(e))));
  // Every KEP reachable from the record counts: PIC/ADMIN need ALL of them in their paroki (order independent).
  const ks = kep.filter((x) => ids(x.fields[F.eventKep.events]).some((e) => eventIds.includes(e)));
  if (ks.length === 0 || !ks.every((k) => inScope(session, parokiOf.get(k.id) ?? []))) throw new HttpError(404);
  const k = ks[0];
  return { eventKep: k, parokiId: session.role === "SEP" ? (parokiOf.get(k.id)?.[0] ?? null) : session.parokiId };
}

/**
 * Every EventKEP linked to these Events rows must be in the actor's scope (an event shared with a KEP of another
 * parish is refused with 404). Used where the rows of the EVENT are disclosed, e.g. the health screen.
 */
export async function assertEventsInScope(session: Session, eventIds: string[]) {
  return kepOfEvent(session, eventIds);
}

async function fetchOr404(table: string, id: string): Promise<AtRecord> {
  if (typeof id !== "string" || !REC_ID.test(id)) throw new HttpError(404);
  try {
    return await getRecord(table, id);
  } catch (e) {
    throw notFoundOrBusy(e);
  }
}

/** Genuine Airtable 404/422 -> 404; a transient failure (429/5xx/network/queue) -> 503 + Retry-After; else rethrow. */
export function notFoundOrBusy(e: unknown): unknown {
  if (isAirtableNotFound(e)) return new HttpError(404);
  if (isTransientAirtableError(e)) return new HttpError(503, "Layanan sedang sibuk. Coba lagi sebentar.", e.retryAfterS ?? 5);
  return e;
}

/** Peserta (Pendaftaran Events row) and its absensi (Pertemuan Hadir) share this scope check. */
export async function assertPesertaInScope(session: Session, pendaftaranId: string) {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  const pendaftaran = await fetchOr404(T.pendaftaranEvents, pendaftaranId);
  const r = await kepOfEvent(session, ids(pendaftaran.fields[F.pendaftaranEvents.event]));
  return { pendaftaran, ...r };
}

/** A pertemuan (SubEvent row), e.g. for absensi; belongs to the KEP behind its Events link. */
export async function assertSubEventInScope(session: Session, subEventId: string) {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  const subEvent = await fetchOr404(T.subEvent, subEventId);
  const r = await kepOfEvent(session, ids(subEvent.fields[F.subEvent.acara]));
  return { subEvent, ...r };
}

/** Every list for PIC/ADMIN goes through these: results are limited to the session's paroki. */
export async function listKepInScope(session: Session): Promise<AtRecord[]> {
  const sc = scopeFilter(session);
  const { kep, parokiOf } = await kepParokiMap();
  return sc.parokiId === "ALL" ? kep : kep.filter((k) => (parokiOf.get(k.id) ?? []).includes(sc.parokiId));
}

const EVENT_CHUNK = 15;
const PESERTA_TTL_MS = 15_000;
/** Formula string literal: backslash and double quote escaped. Only ever fed Airtable-sourced constants. */
const fstr = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** EventID text (the Events primary value that Pendaftaran's link shows) per Events record id, cached. */
async function eventIdTexts(eventIds: string[]): Promise<Map<string, string>> {
  const want = [...new Set(eventIds.filter((i) => REC_ID.test(i)))].sort();
  const out = new Map<string, string>();
  for (let i = 0; i < want.length; i += EVENT_CHUNK) {
    const part = want.slice(i, i + EVENT_CHUNK);
    const rows = await cachedList(T.events, [EVENT_ID_FIELD], `OR(${part.map((id) => `RECORD_ID()="${id}"`).join(",")})`, { ttlMs: 10 * 60_000 });
    for (const r of rows) if (typeof r.fields[EVENT_ID_FIELD] === "string" && r.fields[EVENT_ID_FIELD]) out.set(r.id, r.fields[EVENT_ID_FIELD] as string);
  }
  return out;
}

/**
 * Rows of `table` whose `linkField` (a link to Events) points at one of `eventIds`, read by EventID text in the link
 * primary values (FIND(EventID, ARRAYJOIN({link}))), chunked by 15 events, through the shared cache (key = fields +
 * formula, so the scope is part of it). The id-based filter stays the authority (substring matches). `fresh`
 * bypasses the cache (write paths), `ttlMs` shortens it. Never reads the whole table unless an event has no EventID
 * text (logged; same fallback as the read model).
 */
export async function listLinkedToEvents(
  table: string,
  linkField: string,
  fields: string[],
  eventIds: string[],
  o: { fresh?: boolean; ttlMs?: number; maxAgeMs?: number } = {},
): Promise<AtRecord[]> {
  const events = new Set(eventIds);
  if (events.size === 0) return [];
  const fl = [...new Set([...fields, linkField])];
  const copt = o.fresh ? { maxAgeMs: 0 } : { ttlMs: o.ttlMs, maxAgeMs: o.maxAgeMs };
  const texts = await eventIdTexts([...events]);
  let rows: AtRecord[];
  if ([...events].some((e) => !texts.has(e))) {
    console.warn("[guard] event without EventID text: reading the linked table unfiltered");
    rows = await cachedList(table, fl, undefined, copt);
  } else {
    const vals = [...new Set(texts.values())].sort();
    const parts: AtRecord[][] = [];
    for (let i = 0; i < vals.length; i += EVENT_CHUNK) {
      const part = vals.slice(i, i + EVENT_CHUNK);
      const f = `OR(${part.map((v) => `FIND(${fstr(v)},ARRAYJOIN({${linkField}}))>0`).join(",")})`;
      parts.push(await cachedList(table, fl, f, copt));
    }
    rows = [...new Map(parts.flat().map((r) => [r.id, r])).values()];
  }
  return rows.filter((p) => ids(p.fields[linkField]).some((e) => events.has(e)));
}

/** Registrations of the KEPs in scope (optionally one KEP); 15 s cache, `fresh` for write paths. */
export async function listPesertaInScope(session: Session, fields: string[], eventKepId?: string, o: { fresh?: boolean } = {}): Promise<AtRecord[]> {
  let keps = await listKepInScope(session);
  if (eventKepId) keps = keps.filter((k) => k.id === eventKepId);
  const events = keps.flatMap((k) => ids(k.fields[F.eventKep.events]));
  return listLinkedToEvents(T.pendaftaranEvents, F.pendaftaranEvents.event, fields, events, o.fresh ? { fresh: true } : { ttlMs: PESERTA_TTL_MS });
}

/**
 * Every authenticated GET API shares one per-account budget on top of any route-specific limit, so a script or a
 * stuck client cannot drain the base-wide Airtable budget (5 req/s per base). Generous for real use: the pewarta
 * list loads one photo per card.
 */
export const GET_LIMIT = 600;
export const GET_WINDOW_S = 600;

export type AuthContext<P = Record<string, string>> = { session: Session; params: P };
type Handler<P> = (req: Request, ctx: AuthContext<P>) => Promise<Response> | Response;

/**
 * Wraps a Next route handler: CSRF guard for mutating methods, session (sliding renewal re-sets the
 * cookie), role check, then the handler. HttpError becomes a JSON response; anything else a generic 500.
 */
export function withAuth<P = Record<string, string>>(handler: Handler<P>, opts: { roles: Role[]; multipart?: boolean }) {
  return async (req: Request, routeCtx?: { params?: Promise<P> | P }): Promise<Response> => {
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const blocked = guardPost(req, { multipart: opts.multipart });
        if (blocked) return blocked;
      }
      const { session, token } = await authenticate(req);
      requireRole(session, opts.roles);
      if (req.method === "GET" || req.method === "HEAD") {
        const lim = await rateLimit(limitKey("api-get", session.accountId), GET_LIMIT, GET_WINDOW_S);
        if (!lim.ok) return tooMany(lim.retryAfter);
      }
      const params = (await routeCtx?.params) ?? ({} as P);
      const res = await handler(req, { session, params });
      // A handler that set or cleared the session cookie (logout, password change) wins: no renewal then.
      const touched = res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`));
      return touched ? res : withCookies(res, [sessionCookie(token)]);
    } catch (e) {
      return errorResponse(e);
    }
  };
}
