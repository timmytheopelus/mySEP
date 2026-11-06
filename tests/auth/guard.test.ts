import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());

import {
  HttpError,
  assertKepInScope,
  assertPesertaInScope,
  assertSubEventInScope,
  listKepInScope,
  listPesertaInScope,
  requireRole,
  requireSession,
  scopeFilter,
  withAuth,
} from "@/lib/auth/guard";
import { SESSION_COOKIE, clearSessionCache, invalidateAccount, issueSession, type Session } from "@/lib/auth/session";
import { pickAllowedForRole, pickAllowed } from "@/lib/airtable/schema";
import { getRecord } from "@/lib/airtable/client";
import { clearSessionCookie, sessionCookie } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";

const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const sep: Session = { accountId: "recSEP00000000001", email: "sep@x.id", role: "SEP", parokiId: null };
const picA: Session = { accountId: "recPICA0000000001", email: "pica@x.id", role: "PIC", parokiId: PA };
const admB: Session = { accountId: "recADMB0000000001", email: "admb@x.id", role: "ADMIN", parokiId: PB };
const OTP = { amr: ["pwd", "otp"] as ("pwd" | "otp")[] };

const A = F.akunKep;
async function seed() {
  await seedAccount({ id: sep.accountId, email: sep.email, peran: "SEP" });
  await seedAccount({ id: picA.accountId, email: picA.email, peran: "PIC Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: admB.accountId, email: admB.email, peran: "Admin Paroki", fields: { [A.paroki]: [PB] } });
  store[T.penyelenggaraKep] = [
    { id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: "recORGB0000000001", fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  store[T.eventKep] = [
    { id: "recKEPA0000000001", fields: { [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.events]: ["recEVTA0000000001"] } },
    { id: "recKEPB0000000001", fields: { [F.eventKep.penyelenggara]: ["recORGB0000000001"], [F.eventKep.events]: ["recEVTB0000000001"] } },
  ];
  store[T.pendaftaranEvents] = [
    { id: "recPSTA0000000001", fields: { [F.pendaftaranEvents.event]: ["recEVTA0000000001"] } },
    { id: "recPSTB0000000001", fields: { [F.pendaftaranEvents.event]: ["recEVTB0000000001"] } },
    { id: "recPSTX0000000001", fields: { [F.pendaftaranEvents.event]: ["recEVTNONKEP0001"] } },
  ];
  store[T.subEvent] = [
    { id: "recSUBA0000000001", fields: { [F.subEvent.acara]: ["recEVTA0000000001"] } },
    { id: "recSUBB0000000001", fields: { [F.subEvent.acara]: ["recEVTB0000000001"] } },
  ];
}

const ck = async (s: Session, o: Parameters<typeof issueSession>[1] = OTP) => `${SESSION_COOKIE}=${await issueSession(s, o)}`;
const req = async (s: Session | null, init: RequestInit = {}) =>
  new Request("https://kep.test/api/x", {
    ...init,
    headers: { ...(s ? { cookie: await ck(s) } : {}), ...(init.headers as object) },
  });
const post = (s: Session | null, extra: Record<string, string> = {}) =>
  req(s, { method: "POST", body: "{}", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...extra } });
const status = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as HttpError | null;

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "x".repeat(40));
  resetStore();
  clearSessionCache();
  await seed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("requireSession / requireRole / scopeFilter", () => {
  it("401 without or with a bad cookie", async () => {
    expect((await status(requireSession(await req(null))))?.status).toBe(401);
    const bad = new Request("https://kep.test/x", { headers: { cookie: `${SESSION_COOKIE}=garbage` } });
    expect((await status(requireSession(bad)))?.status).toBe(401);
  });
  it("returns the session; admin with amr google or pwd is valid", async () => {
    expect(await requireSession(await req(picA))).toEqual(picA);
    const r1 = new Request("https://k.test/", { headers: { cookie: await ck(admB, { amr: ["google"] }) } });
    expect(await requireSession(r1)).toEqual(admB);
    const r2 = new Request("https://k.test/", { headers: { cookie: await ck(admB, { amr: ["pwd"] }) } });
    expect(await requireSession(r2)).toEqual(admB);
  });
  it("SEP/PIC without amr otp are invalid", async () => {
    expect((await status(requireSession(new Request("https://k.test/", { headers: { cookie: await ck(sep, { amr: ["pwd"] }) } }))))?.status).toBe(401);
    expect((await status(requireSession(new Request("https://k.test/", { headers: { cookie: await ck(picA, { amr: ["google"] }) } }))))?.status).toBe(401);
  });
  it("ADMIN hitting a SEP/PIC guard gets 403; PIC/ADMIN without paroki get 403", () => {
    expect(() => requireRole(admB, ["SEP", "PIC"])).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => requireRole(picA, ["SEP", "PIC"])).not.toThrow();
    const orphan = { ...picA, parokiId: null };
    expect(() => requireRole(orphan, ["PIC"])).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => scopeFilter({ ...admB, parokiId: null })).toThrowError(expect.objectContaining({ status: 403 }));
  });
  it("scopeFilter", () => {
    expect(scopeFilter(sep)).toEqual({ parokiId: "ALL" });
    expect(scopeFilter(picA)).toEqual({ parokiId: PA });
  });
});

describe("revocation", () => {
  it("deactivated account loses access within the 60 s cache window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const r = await req(picA);
    expect(await requireSession(r)).toEqual(picA);
    store[T.akunKep].find((a) => a.id === picA.accountId)!.fields[A.statusAktif] = false;
    expect(await requireSession(r)).toEqual(picA); // cached
    vi.setSystemTime(Date.now() + 61_000);
    expect((await status(requireSession(r)))?.status).toBe(401);
  });
  it("password change voids older sessions but not new ones", async () => {
    const old = await req(picA);
    expect(await requireSession(old)).toEqual(picA);
    store[T.akunKep].find((a) => a.id === picA.accountId)!.fields[A.hashPassword] = await hashPassword("a brand new password 123");
    invalidateAccount(picA.accountId);
    expect((await status(requireSession(old)))?.status).toBe(401);
    expect(await requireSession(await req(picA))).toEqual(picA);
  });
  it("a token without pf claim is invalid", async () => {
    const { SignJWT } = await import("jose");
    const t = await new SignJWT({ email: picA.email, role: "PIC", sa: Math.floor(Date.now() / 1000), amr: ["pwd", "otp"] })
      .setProtectedHeader({ alg: "HS256" }).setIssuer("kep").setAudience("kep-session").setSubject(picA.accountId)
      .setIssuedAt().setExpirationTime("15m").sign(new TextEncoder().encode("x".repeat(40)));
    expect((await status(requireSession(new Request("https://k.test/", { headers: { cookie: `${SESSION_COOKIE}=${t}` } }))))?.status).toBe(401);
  });
});

describe("IDOR matrix", () => {
  const KA = "recKEPA0000000001", KB = "recKEPB0000000001";
  it("assertKepInScope: SEP all, own paroki ok, foreign 404, malformed/unknown 404", async () => {
    expect((await assertKepInScope(sep, KA)).eventKep.id).toBe(KA);
    expect((await assertKepInScope(sep, KB)).eventKep.id).toBe(KB);
    expect((await assertKepInScope(picA, KA)).parokiId).toBe(PA);
    expect((await assertKepInScope(admB, KB)).parokiId).toBe(PB);
    for (const [s, id] of [[picA, KB], [admB, KA], [picA, "recNOPE0000000000"], [picA, "x\" OR 1=1"], [picA, ""]] as const) {
      expect((await status(assertKepInScope(s, id)))?.status).toBe(404);
    }
  });
  it("misconfigured PIC without paroki gets 403, not everything", async () => {
    expect((await status(assertKepInScope({ ...picA, parokiId: null }, KA)))?.status).toBe(403);
  });
  it("KEP with no organizer is invisible to PIC/ADMIN", async () => {
    store[T.eventKep].push({ id: "recKEPC0000000001", fields: {} });
    expect((await status(assertKepInScope(picA, "recKEPC0000000001")))?.status).toBe(404);
  });
  it("peserta and absensi (subEvent): own ok, foreign 404, SEP all, non-KEP 404", async () => {
    expect((await assertPesertaInScope(sep, "recPSTB0000000001")).pendaftaran.id).toBe("recPSTB0000000001");
    expect((await assertPesertaInScope(picA, "recPSTA0000000001")).parokiId).toBe(PA);
    expect((await status(assertPesertaInScope(picA, "recPSTB0000000001")))?.status).toBe(404);
    expect((await status(assertPesertaInScope(admB, "recPSTA0000000001")))?.status).toBe(404);
    expect((await status(assertPesertaInScope(sep, "recPSTX0000000001")))?.status).toBe(404);
    expect((await assertSubEventInScope(admB, "recSUBB0000000001")).subEvent.id).toBe("recSUBB0000000001");
    expect((await status(assertSubEventInScope(admB, "recSUBA0000000001")))?.status).toBe(404);
    expect((await status(assertSubEventInScope(picA, "recSUBB0000000001")))?.status).toBe(404);
    expect((await assertSubEventInScope(sep, "recSUBA0000000001")).subEvent.id).toBe("recSUBA0000000001");
  });
  it("lists are scoped to the paroki", async () => {
    expect((await listKepInScope(sep)).map((k) => k.id).sort()).toEqual([KA, KB]);
    expect((await listKepInScope(picA)).map((k) => k.id)).toEqual([KA]);
    expect((await listPesertaInScope(admB, [])).map((p) => p.id)).toEqual(["recPSTB0000000001"]);
    expect((await listPesertaInScope(picA, [], KB))).toEqual([]);
    expect((await listPesertaInScope(sep, [])).map((p) => p.id).sort()).toEqual(["recPSTA0000000001", "recPSTB0000000001"]);
  });
});

describe("withAuth", () => {
  const ok = withAuth(async (_r, { session }) => Response.json({ who: session.email }), { roles: ["SEP", "PIC"] });
  it("401 / 403 / 200 and re-sets the sliding session cookie", async () => {
    expect((await ok(await req(null))).status).toBe(401);
    expect((await ok(await req(admB))).status).toBe(403);
    const res = await ok(await req(picA));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ who: picA.email });
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toContain(`${SESSION_COOKIE}=`);
    expect(sc).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });
  it("mutating methods require CSRF-safe JSON; handler HttpError and crashes map to safe responses", async () => {
    expect((await ok(await req(picA, { method: "POST", body: "{}" }))).status).toBe(415);
    expect((await ok(await post(picA, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await ok(await post(picA))).status).toBe(200);
    const nf = withAuth(async () => { throw new HttpError(404); }, { roles: ["PIC"] });
    expect((await nf(await post(picA))).status).toBe(404);
    const boom = withAuth(async () => { throw new Error("secret detail"); }, { roles: ["PIC"] });
    const r = await boom(await post(picA));
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("secret detail");
  });
  it("passes route params and enforces scope end to end", async () => {
    const h = withAuth<{ id: string }>(async (_r, { session, params }) => {
      const { eventKep } = await assertKepInScope(session, params.id);
      return Response.json({ id: eventKep.id });
    }, { roles: ["SEP", "PIC", "ADMIN"] });
    const good = await h(await req(picA), { params: Promise.resolve({ id: "recKEPA0000000001" }) });
    expect(good.status).toBe(200);
    const bad = await h(await req(picA), { params: Promise.resolve({ id: "recKEPB0000000001" }) });
    expect(bad.status).toBe(404);
  });
});

describe("fix round 1", () => {
  it("shared records are in scope only if ALL linked KEPs are in the actor's paroki, in any row order", async () => {
    const base = structuredClone(store[T.eventKep]);
    const sharedSub = { id: "recSUBS0000000001", fields: { [F.subEvent.acara]: ["recEVTB0000000001", "recEVTA0000000001"] } };
    const sharedPst = { id: "recPSTS0000000001", fields: { [F.pendaftaranEvents.event]: ["recEVTA0000000001", "recEVTB0000000001"] } };
    store[T.subEvent].push(sharedSub);
    store[T.pendaftaranEvents].push(sharedPst);
    for (const order of [base, [...base].reverse()]) {
      store[T.eventKep] = structuredClone(order);
      for (const s of [picA, admB]) {
        expect((await status(assertSubEventInScope(s, sharedSub.id)))?.status).toBe(404);
        expect((await status(assertPesertaInScope(s, sharedPst.id)))?.status).toBe(404);
      }
      expect((await assertSubEventInScope(sep, sharedSub.id)).subEvent.id).toBe(sharedSub.id);
    }
    // an Event shared by two KEPs of different parishes
    store[T.eventKep] = [
      { id: "recKEPA0000000001", fields: { [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.events]: ["recEVTA0000000001"] } },
      { id: "recKEPB0000000001", fields: { [F.eventKep.penyelenggara]: ["recORGB0000000001"], [F.eventKep.events]: ["recEVTA0000000001"] } },
    ];
    for (const order of [store[T.eventKep], [...store[T.eventKep]].reverse()]) {
      store[T.eventKep] = order;
      expect((await status(assertSubEventInScope(picA, "recSUBA0000000001")))?.status).toBe(404);
    }
    // a KEP with no organizer among the linked ones also blocks
    store[T.eventKep] = [
      { id: "recKEPA0000000001", fields: { [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.events]: ["recEVTA0000000001"] } },
      { id: "recKEPC0000000001", fields: { [F.eventKep.events]: ["recEVTA0000000001"] } },
    ];
    expect((await status(assertSubEventInScope(picA, "recSUBA0000000001")))?.status).toBe(404);
  });

  it("account with several paroki links or none gets 403, never the first link", async () => {
    await seedAccount({ id: "recMULT0000000001", email: "m@x.id", peran: "PIC Paroki", fields: { [A.paroki]: [PB, PA] } });
    await seedAccount({ id: "recNONE0000000001", email: "n@x.id", peran: "Admin Paroki" });
    for (const id of ["recMULT0000000001", "recNONE0000000001"]) {
      const role = id.startsWith("recMULT") ? "PIC" : "ADMIN";
      const r = new Request("https://k.test/", { headers: { cookie: await ck({ accountId: id, email: "x", role, parokiId: PA } as Session) } });
      const s = await requireSession(r);
      expect(s.parokiId).toBeNull();
      const h = withAuth(async () => Response.json({}), { roles: ["PIC", "ADMIN"] });
      const res = await h(r);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toBe('{"error":"Tidak diizinkan"}');
      expect((await status(assertKepInScope(s, "recKEPA0000000001")))?.status).toBe(403);
    }
  });

  it("withAuth: handler-set session cookie (logout, re-issue) wins; otherwise renewed", async () => {
    const logout = withAuth(async () => { const r = Response.json({ ok: true }); r.headers.append("Set-Cookie", clearSessionCookie()); return r; }, { roles: ["PIC"] });
    const r1 = await logout(await post(picA));
    expect(r1.headers.getSetCookie()).toEqual([clearSessionCookie()]);
    const fresh = await issueSession(picA, OTP);
    const reissue = withAuth(async () => { const r = Response.json({ ok: true }); r.headers.append("Set-Cookie", sessionCookie(fresh)); return r; }, { roles: ["PIC"] });
    const r2 = await reissue(await post(picA));
    expect(r2.headers.getSetCookie()).toEqual([sessionCookie(fresh)]);
    const plain = withAuth(async () => Response.json({}), { roles: ["PIC"] });
    expect((await plain(await post(picA))).headers.getSetCookie()).toHaveLength(1);
  });

  it("SEP with unknown KEP id gets 404; malformed ids never reach getRecord", async () => {
    expect((await status(assertKepInScope(sep, "recNOPE0000000000")))?.status).toBe(404);
    for (const bad of ["../x", "recA/../B", "recSHORT", "x".repeat(40)]) {
      expect((await status(assertPesertaInScope(sep, bad)))?.status).toBe(404);
      expect((await status(assertSubEventInScope(picA, bad)))?.status).toBe(404);
    }
    expect(vi.mocked(getRecord)).not.toHaveBeenCalled();
  });

  it("HttpError supports 400/409/422/429 through withAuth", async () => {
    for (const st of [400, 409, 422, 429] as const) {
      const h = withAuth(async () => { throw new HttpError(st); }, { roles: ["PIC"] });
      expect((await h(await post(picA))).status).toBe(st);
    }
  });
});

describe("per-role write allowlists", () => {
  const K = F.eventKep;
  const input = { [K.statusPersetujuan]: "Disetujui", [K.catatanSep]: "ok", [K.penyelenggara]: ["recORGB0000000001"], [K.events]: ["recEVTA0000000001"] };
  it("PIC/ADMIN input drops restricted fields; SEP keeps them", () => {
    for (const role of ["PIC", "ADMIN"]) expect(pickAllowedForRole(T.eventKep, role, input)).toEqual({ [K.events]: ["recEVTA0000000001"] });
    expect(Object.keys(pickAllowedForRole(T.eventKep, "SEP", input)).sort()).toEqual(Object.keys(input).sort());
    expect(pickAllowed(T.eventKep, input)).toEqual({ [K.events]: ["recEVTA0000000001"] });
  });
  it("server can set penyelenggara explicitly; Pengelenggara KEP.Paroki is restricted", () => {
    expect(pickAllowed(T.eventKep, input, new Set([K.penyelenggara]))[K.penyelenggara]).toEqual(["recORGB0000000001"]);
    const P = F.penyelenggaraKep.paroki;
    expect(pickAllowedForRole(T.penyelenggaraKep, "PIC", { [P]: [PA] })).toEqual({});
    expect(pickAllowedForRole(T.penyelenggaraKep, "SEP", { [P]: [PA] })).toEqual({ [P]: [PA] });
  });
});
