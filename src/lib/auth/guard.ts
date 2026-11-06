import "server-only";
import { getRecord, listRecords, type AtRecord } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { HttpError } from "@/lib/http/errors";
import { guardPost, json, serverError, tooMany, withCookies } from "@/lib/http/auth-http";
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

/** Paroki ids per EventKEP id, resolved through its Pengelenggara KEP rows (id based, no formulas). */
async function kepParokiMap(): Promise<{ kep: AtRecord[]; parokiOf: Map<string, string[]> }> {
  const [kep, org] = await Promise.all([
    listRecords(T.eventKep, { fields: [F.eventKep.penyelenggara, F.eventKep.events, F.eventKep.statusPersetujuan] }),
    listRecords(T.penyelenggaraKep, { fields: [F.penyelenggaraKep.paroki] }),
  ]);
  const orgParoki = new Map(org.map((o) => [o.id, ids(o.fields[F.penyelenggaraKep.paroki])]));
  const parokiOf = new Map<string, string[]>();
  for (const k of kep) {
    parokiOf.set(k.id, ids(k.fields[F.eventKep.penyelenggara]).flatMap((o) => orgParoki.get(o) ?? []));
  }
  return { kep, parokiOf };
}

/** One scope rule for everybody: ALL sees everything; a paroki sees what lists it as organizer. */
export const parokiAllows = (scope: string | "ALL", parokis: string[]) => scope === "ALL" || parokis.includes(scope);

const inScope = (s: Session, parokis: string[]) =>
  s.role === "SEP" || (!!s.parokiId && parokiAllows(s.parokiId, parokis));

/** SEP: any KEP. PIC/ADMIN: only their paroki. Everything else (missing, foreign, malformed): 404. */
export async function assertKepInScope(
  session: Session,
  eventKepId: string,
): Promise<{ eventKep: AtRecord; parokiId: string | null }> {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  if (typeof eventKepId !== "string" || !REC_ID.test(eventKepId)) throw new HttpError(404);
  const { kep, parokiOf } = await kepParokiMap();
  const eventKep = kep.find((k) => k.id === eventKepId);
  const parokis = parokiOf.get(eventKepId) ?? [];
  if (!eventKep || !inScope(session, parokis)) throw new HttpError(404);
  return { eventKep, parokiId: session.role === "SEP" ? (parokis[0] ?? null) : session.parokiId };
}

/** Resolve the EventKEP behind an Events record id; 404 if it is not a KEP event. */
async function kepOfEvent(session: Session, eventIds: string[]) {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  const { kep, parokiOf } = await kepParokiMap();
  // Every KEP reachable from the record counts: PIC/ADMIN need ALL of them in their paroki (order independent).
  const ks = kep.filter((x) => ids(x.fields[F.eventKep.events]).some((e) => eventIds.includes(e)));
  if (ks.length === 0 || !ks.every((k) => inScope(session, parokiOf.get(k.id) ?? []))) throw new HttpError(404);
  const k = ks[0];
  return { eventKep: k, parokiId: session.role === "SEP" ? (parokiOf.get(k.id)?.[0] ?? null) : session.parokiId };
}

async function fetchOr404(table: string, id: string): Promise<AtRecord> {
  if (typeof id !== "string" || !REC_ID.test(id)) throw new HttpError(404);
  try {
    return await getRecord(table, id);
  } catch {
    throw new HttpError(404);
  }
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

export async function listPesertaInScope(session: Session, fields: string[], eventKepId?: string): Promise<AtRecord[]> {
  let keps = await listKepInScope(session);
  if (eventKepId) keps = keps.filter((k) => k.id === eventKepId);
  const events = new Set(keps.flatMap((k) => ids(k.fields[F.eventKep.events])));
  if (events.size === 0) return [];
  const all = await listRecords(T.pendaftaranEvents, { fields: [...new Set([...fields, F.pendaftaranEvents.event])] });
  return all.filter((p) => ids(p.fields[F.pendaftaranEvents.event]).some((e) => events.has(e)));
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
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      return serverError();
    }
  };
}
