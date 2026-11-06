import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn(), normEmail: (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : null), normPhone: (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : null) }));

import { GET as linkRoute } from "@/app/api/kep/[id]/link-daftar/route";
import { POST as rotateRoute } from "@/app/api/kep/[id]/link-daftar/rotate/route";
import {
  currentLinkVersion,
  registrationTokenExpiry,
  signRegistrationToken,
  verifyRegistrationToken,
  verifyRegistrationTokenCurrent,
} from "@/lib/kep/registration";
import { SESSION_COOKIE, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const A = F.akunKep;
const AU = F.auditKep;
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const adm: Session = { accountId: "recADM0000000001", email: "adm@x.id", role: "ADMIN", parokiId: PA };
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const admB: Session = { accountId: "recPICB000000001", email: "picb@x.id", role: "PIC", parokiId: PB }; // PIC of another parish
const KEP = "recKEPA0000000001";
const KEP_DIAJUKAN = "recKEPD0000000001";
const EV = "recEVA00000000001";
const EV2 = "recEVD00000000001";
const SECRET = "t".repeat(48);
const DAY = 86_400_000;
let ip = 0;

async function call(handler: unknown, body: unknown, o: { as?: Session; method?: string; params: object; headers?: Record<string, string> }) {
  const req = new Request("https://kep.test/api/kep/x", {
    method: o.method ?? "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-real-ip": `10.3.0.${++ip % 250}`,
      ...(o.as ? { cookie: `${SESSION_COOKIE}=${await issueSession(o.as, { amr: ["pwd", "otp"] })}` } : {}),
      ...o.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (handler as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(o.params) });
}
const get = (as?: Session, id = KEP) => call(linkRoute, undefined, { method: "GET", params: { id }, as });
const rotate = (body: unknown, as?: Session, id = KEP) => call(rotateRoute, body, { params: { id }, as });
const marker = (v: number, ev = EV) => ({ id: `recAUD${v}${ev.slice(3, 8)}00`.padEnd(17, "0"), fields: { [AU.aksi]: "link_daftar_rotasi", [AU.targetId]: ev, [AU.sesudah]: JSON.stringify({ v }) } });
const auditOf = (aksi: string) => (store[T.auditKep] ?? []).filter((r) => r.fields[AU.aksi] === aksi);
const tokenOf = (url: string) => url.split("/daftar/")[1];

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("REG_TOKEN_SECRET", SECRET);
  vi.stubEnv("APP_BASE_URL", "https://kep.example.org/");
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  await seedAccount({ id: sep.accountId, email: sep.email, peran: "SEP" });
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: adm.accountId, email: adm.email, peran: "Admin Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: admB.accountId, email: admB.email, peran: "PIC Paroki", fields: { [A.paroki]: [PB] } });
  store[T.penyelenggaraKep] = [{ id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } }];
  store[T.eventKep] = [
    { id: KEP, fields: { [F.eventKep.events]: [EV], [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.statusPersetujuan]: "Disetujui" } },
    { id: KEP_DIAJUKAN, fields: { [F.eventKep.events]: [EV2], [F.eventKep.penyelenggara]: ["recORGA0000000001"], [F.eventKep.statusPersetujuan]: "Diajukan" } },
  ];
  store[T.auditKep] = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("registration token: expiry, issued-at, version", () => {
  const now = new Date("2026-11-07T03:00:00Z");
  const payloadOf = (t: string) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString());

  it("carries event id, version, issued-at and expiry (default 120 days) and nothing personal", () => {
    const t = signRegistrationToken(EV, { now });
    const p = payloadOf(t);
    expect(Object.keys(p).sort()).toEqual(["e", "i", "v", "x"]);
    expect(p.e).toBe(EV);
    expect(p.v).toBe(1);
    expect(p.i).toBe(Math.floor(now.getTime() / 1000));
    expect(p.x).toBe(Math.floor((now.getTime() + 120 * DAY) / 1000));
  });
  it("honours an explicit version and expiry", () => {
    const t = signRegistrationToken(EV, { now, version: 3, expiresAt: new Date(now.getTime() + 5 * DAY) });
    expect(payloadOf(t).v).toBe(3);
    expect(verifyRegistrationToken(t, new Date(now.getTime() + 4 * DAY))).toEqual({ eventId: EV });
  });
  it("is rejected at and after the expiry instant, accepted before", () => {
    const t = signRegistrationToken(EV, { now, expiresAt: new Date(now.getTime() + DAY) });
    expect(verifyRegistrationToken(t, new Date(now.getTime() + DAY - 1000))).toEqual({ eventId: EV });
    expect(verifyRegistrationToken(t, new Date(now.getTime() + DAY))).toBeNull();
    expect(verifyRegistrationToken(t, new Date(now.getTime() + 200 * DAY))).toBeNull();
  });
  it("cannot be extended by editing the payload (signature covers expiry)", () => {
    const t = signRegistrationToken(EV, { now, expiresAt: new Date(now.getTime() + DAY) });
    const [p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payloadOf(t), x: payloadOf(t).x + 999999 })).toString("base64url");
    expect(forged).not.toBe(p);
    expect(verifyRegistrationToken(`${forged}.${s}`, now)).toBeNull();
  });
  it("legacy tokens ({e, v:1}, no expiry) still verify", () => {
    const p = Buffer.from(JSON.stringify({ e: EV, v: 1 })).toString("base64url");
    const sig = createHmac("sha256", Buffer.from(SECRET)).update(p).digest("base64url");
    expect(verifyRegistrationToken(`${p}.${sig}`, now)).toEqual({ eventId: EV });
  });
  it("rejects a non-positive-integer version or malformed expiry", () => {
    for (const bad of [{ e: EV, v: 0, x: 9e9 }, { e: EV, v: 1.5, x: 9e9 }, { e: EV, v: "1", x: 9e9 }, { e: EV, v: 1, x: "soon" }]) {
      const p = Buffer.from(JSON.stringify(bad)).toString("base64url");
      const sig = createHmac("sha256", Buffer.from(SECRET)).update(p).digest("base64url");
      expect(verifyRegistrationToken(`${p}.${sig}`, now)).toBeNull();
    }
  });

  describe("registrationTokenExpiry", () => {
    it("is 120 days without an end date", () => {
      expect(registrationTokenExpiry(now, null).getTime()).toBe(now.getTime() + 120 * DAY);
      expect(registrationTokenExpiry(now, undefined).getTime()).toBe(now.getTime() + 120 * DAY);
    });
    it("is the end of Tanggal Selesai (WIB) when that comes first", () => {
      // 2026-11-20 23:59:59.999 WIB = 2026-11-20 16:59:59.999 UTC
      expect(registrationTokenExpiry(now, "2026-11-20").getTime()).toBe(Date.parse("2026-11-20T16:59:59.999Z"));
    });
    it("is 120 days when the end date is later; garbage dates are ignored", () => {
      expect(registrationTokenExpiry(now, "2030-01-01").getTime()).toBe(now.getTime() + 120 * DAY);
      expect(registrationTokenExpiry(now, "not-a-date").getTime()).toBe(now.getTime() + 120 * DAY);
    });
  });

  describe("version check against AuditKEP", () => {
    it("is version 1 with no rotation markers; a v1 token is current", async () => {
      expect(await currentLinkVersion(EV)).toBe(1);
      expect(await verifyRegistrationTokenCurrent(signRegistrationToken(EV))).toEqual({ eventId: EV });
    });
    it("a rotation marker invalidates older tokens, the new version works", async () => {
      const old = signRegistrationToken(EV, { version: 1 });
      store[T.auditKep].push(marker(2));
      expect(await currentLinkVersion(EV)).toBe(2);
      expect(await verifyRegistrationTokenCurrent(old)).toBeNull();
      expect(await verifyRegistrationTokenCurrent(signRegistrationToken(EV, { version: 2 }))).toEqual({ eventId: EV });
    });
    it("takes the highest marker whatever the row order, and ignores other events and other actions", async () => {
      store[T.auditKep].push(marker(4), marker(2), marker(9, EV2), { id: "recOTHER0000000001", fields: { [AU.aksi]: "link_daftar_dilihat", [AU.targetId]: EV, [AU.sesudah]: JSON.stringify({ v: 77 }) } });
      expect(await currentLinkVersion(EV)).toBe(4);
      expect(await currentLinkVersion(EV2)).toBe(9);
    });
    it("ignores unparsable markers; expired tokens fail even at the current version", async () => {
      store[T.auditKep].push({ id: "recBROKEN000000001", fields: { [AU.aksi]: "link_daftar_rotasi", [AU.targetId]: EV, [AU.sesudah]: "{not json" } });
      expect(await currentLinkVersion(EV)).toBe(1);
      const t = signRegistrationToken(EV, { now: new Date(Date.now() - 10 * DAY), expiresAt: new Date(Date.now() - DAY) });
      expect(await verifyRegistrationTokenCurrent(t)).toBeNull();
    });
    it("garbage tokens never reach Airtable", async () => {
      expect(await verifyRegistrationTokenCurrent("garbage")).toBeNull();
      expect(await verifyRegistrationTokenCurrent("")).toBeNull();
    });
  });
});

describe("ADMIN is PIC-only territory", () => {
  it("GET link-daftar and POST rotate are 403 for Admin Paroki of the own parish", async () => {
    expect((await get(adm)).status).toBe(403);
    expect((await rotate({ opId: "op-rotate-0001" }, adm)).status).toBe(403);
    expect(auditOf("link_daftar_rotasi")).toHaveLength(0);
    expect(auditOf("link_daftar_dilihat")).toHaveLength(0);
  });
});

describe("GET /api/kep/[id]/link-daftar", () => {
  it("401 anonymous, 403 SEP, 404 other parish / unknown / malformed id", async () => {
    expect((await get()).status).toBe(401);
    expect((await get(sep)).status).toBe(403);
    expect((await get(admB)).status).toBe(404);
    expect((await get(pic, "recNOSUCHKEP00001")).status).toBe(404);
    expect((await get(pic, "not-an-id")).status).toBe(404);
  });
  it("409 while the KEP is not Disetujui", async () => {
    const r = await get(pic, KEP_DIAJUKAN);
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).not.toContain("/daftar/");
  });
  it("PIC of the own parish gets the public URL, QR data URL and expiry", async () => {
    for (const who of [pic]) {
      const r = await get(who);
      expect(r.status).toBe(200);
      const b = await r.json();
      expect(b.url).toMatch(/^https:\/\/kep\.example\.org\/daftar\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(b.qr).toMatch(/^data:image\/png;base64,/);
      expect(b.versi).toBe(1);
      expect(Date.parse(b.kadaluarsa)).toBeGreaterThan(Date.now());
      expect(Date.parse(b.kadaluarsa)).toBeLessThanOrEqual(Date.now() + 120 * DAY + 5000);
      expect(verifyRegistrationToken(tokenOf(b.url))).toEqual({ eventId: EV });
    }
  });
  it("expires no later than Tanggal Selesai (WIB end of day)", async () => {
    const end = new Date(Date.now() + 3 * DAY + 7 * 3600_000).toISOString().slice(0, 10);
    store[T.eventKep][0].fields[F.eventKep.tanggalSelesai] = end;
    const b = await (await get(pic)).json();
    expect(Date.parse(b.kadaluarsa)).toBe(Date.parse(`${end}T23:59:59.999+07:00`));
  });
  it("409 once Tanggal Selesai has passed", async () => {
    store[T.eventKep][0].fields[F.eventKep.tanggalSelesai] = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
    expect((await get(pic)).status).toBe(409);
  });
  it("503 (no token issued) when APP_BASE_URL is not configured; 503 when REG_TOKEN_SECRET is short", async () => {
    vi.stubEnv("APP_BASE_URL", "");
    expect((await get(pic)).status).toBe(503);
    vi.stubEnv("APP_BASE_URL", "https://kep.example.org");
    vi.stubEnv("REG_TOKEN_SECRET", "short");
    expect((await get(pic)).status).toBe(503);
  });
  it("uses the current rotation version", async () => {
    store[T.auditKep].push(marker(3));
    const b = await (await get(pic)).json();
    expect(b.versi).toBe(3);
    expect(await verifyRegistrationTokenCurrent(tokenOf(b.url))).toEqual({ eventId: EV });
  });
  it("audits link_daftar_dilihat at most once per hour per actor and KEP, ids only", async () => {
    await get(pic);
    await get(pic);
    await get(pic);
    const rows = auditOf("link_daftar_dilihat");
    expect(rows).toHaveLength(1);
    expect(rows[0].fields[AU.targetId]).toBe(KEP);
    expect(rows[0].fields[AU.pelaku]).toBe(pic.email);
    expect(JSON.stringify(rows[0].fields)).not.toMatch(/daftar\/|https?:/);
    await get(pic, KEP);
    expect(auditOf("link_daftar_dilihat")).toHaveLength(1);
  });
});

describe("POST /api/kep/[id]/link-daftar/rotate", () => {
  const body = (opId = "op-rotate-0001") => ({ opId });
  it("401 anonymous, 403 SEP, 404 other parish, 403 without same-origin", async () => {
    expect((await rotate(body())).status).toBe(401);
    expect((await rotate(body(), sep)).status).toBe(403);
    expect((await rotate(body(), admB)).status).toBe(404);
    expect((await call(rotateRoute, body(), { params: { id: KEP }, as: pic, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(auditOf("link_daftar_rotasi")).toHaveLength(0);
  });
  it("422 for a bad opId or unknown keys", async () => {
    expect((await rotate({}, pic)).status).toBe(422);
    expect((await rotate({ opId: "x" }, pic)).status).toBe(422);
    expect((await rotate({ opId: "op-rotate-0001", versi: 99 }, pic)).status).toBe(422);
    expect(auditOf("link_daftar_rotasi")).toHaveLength(0);
  });
  it("invalidates links issued before, audits with ids only, and the next GET issues a working one", async () => {
    const before = await (await get(pic)).json();
    const r = await rotate(body(), pic);
    expect(r.status).toBe(200);
    expect((await r.json()).versi).toBe(2);
    expect(await verifyRegistrationTokenCurrent(tokenOf(before.url))).toBeNull();
    const rows = auditOf("link_daftar_rotasi");
    expect(rows).toHaveLength(1);
    expect(rows[0].fields[AU.targetId]).toBe(EV);
    expect(rows[0].fields[AU.pelaku]).toBe(pic.email);
    expect(JSON.parse(String(rows[0].fields[AU.sesudah])).v).toBe(2);
    expect(JSON.stringify(rows[0].fields)).not.toContain(tokenOf(before.url));
    const after = await (await get(pic)).json();
    expect(after.versi).toBe(2);
    expect(await verifyRegistrationTokenCurrent(tokenOf(after.url))).toEqual({ eventId: EV });
  });
  it("is idempotent per opId and increments again for a new opId", async () => {
    expect((await (await rotate(body("op-rotate-0001"), pic)).json()).versi).toBe(2);
    expect((await (await rotate(body("op-rotate-0001"), pic)).json()).versi).toBe(2);
    expect(auditOf("link_daftar_rotasi")).toHaveLength(1);
    expect((await (await rotate(body("op-rotate-0002"), pic)).json()).versi).toBe(3);
    expect(auditOf("link_daftar_rotasi")).toHaveLength(2);
  });
  it("refuses to rotate when the audit row cannot be written (fail closed)", async () => {
    const { createRecords } = await import("@/lib/airtable/client");
    vi.mocked(createRecords).mockRejectedValueOnce(new Error("airtable down"));
    expect((await rotate(body(), pic)).status).toBe(500);
    expect(await currentLinkVersion(EV)).toBe(1);
  });
});
