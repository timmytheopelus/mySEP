import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { EVENT_ID_FIELD, F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/email", () => ({ sendMail: vi.fn(async () => undefined), mailConfigured: () => false, appBaseUrl: () => "https://kep.test", setMailer: () => undefined }));

import { POST as walkinRoute } from "@/app/api/kep/[id]/absen/[subEventId]/tambah/route";
import { getAbsenSheet } from "@/lib/kep/absensi";
import { getKepHub } from "@/lib/kep/hub";
import { WalkInInput } from "@/lib/kep/registration";
import { SESSION_COOKIE, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const A = F.akunKep;
const P = F.pendaftaranEvents;
const U = F.teamUmat;
const AU = F.auditKep;
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: PA };
const adm: Session = { accountId: "recADMA000000001", email: "adma@x.id", role: "ADMIN", parokiId: PA };
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const admB: Session = { accountId: "recADMB000000001", email: "admb@x.id", role: "ADMIN", parokiId: PB };
const KEP = "recKEPA0000000001";
const KEP_D = "recKEPD0000000001"; // Diajukan
const KEP_B = "recKEPB0000000001";
const EV = "recEVA00000000001";
const EV_D = "recEVD00000000001";
const EV_B = "recEVB00000000001";
const S1 = "recSUB1000000001";
const S2 = "recSUB2000000001";
const SD = "recSUBD000000001";
const SB = "recSUBB000000001";
let ip = 0;

async function call(body: unknown, as: Session | null = adm, params = { id: KEP, subEventId: S1 }) {
  const req = new Request("https://kep.test/api/kep/x/absen/y/tambah", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-real-ip": `10.6.0.${++ip % 250}`,
      ...(as ? { cookie: `${SESSION_COOKIE}=${await issueSession(as, { amr: ["pwd", "otp"] })}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return (walkinRoute as unknown as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(params) });
}
const B = { namaLengkap: "Yohana Tamu", wa: "0812-3456-7890", opId: "op-walkin-0001" };
const add = (extra: Record<string, unknown> = {}, as: Session | null = adm, params = { id: KEP, subEventId: S1 }) => call({ ...B, ...extra }, as, params);
const audit = (aksi: string) => (store[T.auditKep] ?? []).filter((r) => r.fields[AU.aksi] === aksi);

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  invalidateKepCache();
  await seedAccount({ id: sep.accountId, email: sep.email, peran: "SEP" });
  await seedAccount({ id: pic.accountId, email: pic.email, peran: "PIC Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: adm.accountId, email: adm.email, peran: "Admin Paroki", fields: { [A.paroki]: [PA] } });
  await seedAccount({ id: admB.accountId, email: admB.email, peran: "Admin Paroki", fields: { [A.paroki]: [PB] } });
  store[T.paroki] = [{ id: PA, fields: { [F.paroki.nama]: "A" } }, { id: PB, fields: { [F.paroki.nama]: "B" } }];
  store[T.penyelenggaraKep] = [
    { id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: "recORGB0000000001", fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  const k = (ev: string, org: string, st: string) => ({ [F.eventKep.events]: [ev], [F.eventKep.penyelenggara]: [org], [F.eventKep.statusPersetujuan]: st });
  store[T.eventKep] = [
    { id: KEP, fields: k(EV, "recORGA0000000001", "Disetujui") },
    { id: KEP_D, fields: k(EV_D, "recORGA0000000001", "Diajukan") },
    { id: KEP_B, fields: k(EV_B, "recORGB0000000001", "Disetujui") },
  ];
  store[T.events] = [EV, EV_D, EV_B].map((id) => ({ id, fields: { [F.events.namaAcara]: `KEP ${id}`, [F.events.kelompokAcara]: "KEP", [EVENT_ID_FIELD]: `2611-${id}` } }));
  const s = (ev: string, n: number) => ({ [F.subEvent.acara]: [ev], [F.subEvent.agenda]: `Bab ${n}`, [F.subEvent.urutan]: n, [F.subEvent.tanggal]: "2026-11-07" });
  store[T.subEvent] = [{ id: S1, fields: s(EV, 1) }, { id: S2, fields: s(EV, 2) }, { id: SD, fields: s(EV_D, 1) }, { id: SB, fields: s(EV_B, 1) }];
  store[T.teamUmat] = [
    { id: "recTEAM0000000001", fields: { [U.namaLengkap]: "Agnes", [U.noWhatsapp]: "6281111111111", [U.email]: "agnes@x.id", [U.tanggalLahir]: "1980-01-01" } },
  ];
  store[T.pendaftaranEvents] = [
    { id: "recPEND0000000001", fields: { [P.event]: [EV], [P.teamUmat]: ["recTEAM0000000001"], [P.statusPendaftaran]: "Daftar", [P.kategoriKepesertaan]: "Peserta" } },
  ];
  store[T.auditKep] = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("WalkInInput", () => {
  it("name + WhatsApp are required, email optional (blank = none), no health fields exist", () => {
    expect(WalkInInput.safeParse({ namaLengkap: "Ana", wa: "0812-111-22233" }).success).toBe(true);
    expect(WalkInInput.safeParse({ namaLengkap: "Ana", wa: "0812-111-22233", email: "" }).data?.email).toBeUndefined();
    expect(WalkInInput.safeParse({ namaLengkap: "Ana", wa: "0812-111-22233", email: "bukan-email" }).success).toBe(false);
    expect(WalkInInput.safeParse({ namaLengkap: "Ana", wa: "123" }).success).toBe(false);
    expect(WalkInInput.safeParse({ namaLengkap: "http://evil.id", wa: "0812-111-22233" }).success).toBe(false);
    const withHealth = WalkInInput.parse({ namaLengkap: "Ana", wa: "0812-111-22233", riwayatPenyakit: "x" }) as Record<string, unknown>;
    expect(withHealth.riwayatPenyakit).toBeUndefined(); // stripped
  });
});

describe("POST /api/kep/[id]/absen/[subEventId]/tambah (walk-in, I8)", () => {
  it("ADMIN and PIC of the parish register a new person and mark them hadir for THIS meeting", async () => {
    const r = await add({}, adm);
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j).toMatchObject({ status: "registered", hadir: true });
    const row = store[T.pendaftaranEvents].find((x) => x.id === j.pendaftaranId)!;
    expect(row.fields[P.pertemuanHadir]).toEqual([S1]);
    expect(row.fields[P.kategoriKepesertaan]).toBe("Peserta");
    expect(row.fields[P.event]).toEqual([EV]);
    const person = store[T.teamUmat].find((x) => x.id === (row.fields[P.teamUmat] as string[])[0])!;
    expect(person.fields[U.namaLengkap]).toBe("Yohana Tamu");
    expect(person.fields[U.noWhatsapp]).toBe("6281234567890");
    expect(U.email in person.fields).toBe(false); // optional email left empty, not ""
    expect(row.fields[P.riwayatPenyakit]).toBeUndefined();
    const r2 = await add({ namaLengkap: "Petrus Tamu", wa: "0813-9999-8888", opId: "op-walkin-0002" }, pic);
    expect(r2.status).toBe(201);
    const sheet = await getAbsenSheet(pic, KEP, S1);
    expect(sheet.peserta.map((p) => p.nama).sort()).toEqual(["Agnes", "Petrus Tamu", "Yohana Tamu"]);
    expect(sheet.peserta.find((p) => p.nama === "Yohana Tamu")?.hadir).toBe(true);
    const s2 = await getAbsenSheet(pic, KEP, S2);
    expect(s2.peserta.find((p) => p.nama === "Yohana Tamu")?.hadir).toBe(false); // only the current meeting
  });
  it("optional email is stored (lowercased) when given", async () => {
    const r = await add({ email: "Yohana@Example.com" });
    expect(r.status).toBe(201);
    expect(store[T.teamUmat].some((p) => p.fields[U.email] === "yohana@example.com")).toBe(true);
  });
  it("SEP 403, anonymous 401, other parish 404, Diajukan KEP 409, pertemuan of another KEP 404; nothing is written", async () => {
    expect((await add({}, sep)).status).toBe(403);
    expect((await add({}, null)).status).toBe(401);
    expect((await add({}, admB)).status).toBe(404);
    expect((await add({}, adm, { id: KEP_D, subEventId: SD })).status).toBe(409);
    expect((await add({}, adm, { id: KEP, subEventId: SB })).status).toBe(404);
    expect((await add({}, adm, { id: KEP, subEventId: "recNOPE000000001x" })).status).toBe(404);
    expect(store[T.teamUmat]).toHaveLength(1);
    expect(store[T.pendaftaranEvents]).toHaveLength(1);
  });
  it.each([
    ["missing name", { namaLengkap: "" }],
    ["bad WhatsApp", { wa: "12" }],
    ["bad email", { email: "x" }],
    ["bad opId", { opId: "x" }],
  ])("validation: %s -> 422 with field messages, nothing written", async (_n, extra) => {
    const r = await add(extra);
    expect(r.status).toBe(422);
    expect(store[T.teamUmat]).toHaveLength(1);
  });
  it("an EXISTING person (same WhatsApp) is never written to: the new registration points at them, they are marked hadir", async () => {
    store[T.teamUmat].push({ id: "recTEAM0000000003", fields: { [U.namaLengkap]: "Dewi Lama", [U.noWhatsapp]: "6283333333333", [U.email]: "dewi@x.id" } });
    const before = structuredClone(store[T.teamUmat]);
    const r = await add({ namaLengkap: "Nama Lain Sekali", wa: "0833-3333-3333", email: "baru@x.id" });
    expect(r.status).toBe(201);
    expect(store[T.teamUmat]).toEqual(before);
    const j = await r.json();
    const row = store[T.pendaftaranEvents].find((x) => x.id === j.pendaftaranId)!;
    expect(row.fields[P.teamUmat]).toEqual(["recTEAM0000000003"]);
    expect(row.fields[P.pertemuanHadir]).toEqual([S1]);
  });
  it("walk-in without email never matches a person that merely has a blank email", async () => {
    store[T.teamUmat].push({ id: "recTEAM0000000002", fields: { [U.namaLengkap]: "Tanpa Email", [U.noWhatsapp]: "6282222222222" } });
    const r = await add();
    expect(r.status).toBe(201);
    const { pendaftaranId } = await r.json();
    const row = store[T.pendaftaranEvents].find((x) => x.id === pendaftaranId)!;
    expect(row.fields[P.teamUmat]).not.toEqual(["recTEAM0000000002"]);
    expect(store[T.teamUmat]).toHaveLength(3);
  });
  it("already registered in this KEP: no second registration, they are marked hadir (200)", async () => {
    const r = await add({ namaLengkap: "Agnes", wa: "0811-1111-1111" });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("already_registered");
    expect(store[T.pendaftaranEvents]).toHaveLength(1);
    expect(store[T.pendaftaranEvents][0].fields[P.pertemuanHadir]).toEqual([S1]);
  });
  it("a peserta who already withdrew (mundur) cannot be marked: 409 and the message says so", async () => {
    store[T.pendaftaranEvents][0].fields[P.keterangan] = "MENGUNDURKAN DIRI";
    const r = await add({ namaLengkap: "Agnes", wa: "0811-1111-1111" });
    expect(r.status).toBe(409);
    expect(store[T.pendaftaranEvents][0].fields[P.pertemuanHadir]).toBeUndefined();
  });
  it("retry with the same opId (e.g. after a timeout) is idempotent: one person, one registration, still hadir", async () => {
    expect((await add()).status).toBe(201);
    const r = await add();
    expect(r.status).toBe(200);
    expect(store[T.teamUmat]).toHaveLength(2);
    expect(store[T.pendaftaranEvents]).toHaveLength(2);
    expect(store[T.pendaftaranEvents].find((x) => x.id !== "recPEND0000000001")!.fields[P.pertemuanHadir]).toEqual([S1]);
  });
  it("audit: walk-in row carries ids only (no name, WhatsApp or email)", async () => {
    await add({ email: "yohana@example.com" });
    const rows = [...audit("peserta_walkin_daftar"), ...audit("absen_set")];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const json = JSON.stringify(store[T.auditKep]);
    for (const secret of ["Yohana", "6281234567890", "0812-3456", "yohana@example.com"]) expect(json).not.toContain(secret);
  });
  it("the hub flags walk-ins whose data is incomplete (names only) and counts them", async () => {
    await add();
    const hub = await getKepHub(pic, KEP);
    expect(hub.belumLengkap).toBe(1);
    expect(hub.peserta?.find((p) => p.nama === "Yohana Tamu")?.belumLengkap).toBe(true);
    expect(hub.peserta?.find((p) => p.nama === "Agnes")?.belumLengkap).toBe(false);
    const json = JSON.stringify(hub);
    expect(json).not.toContain("6281234567890");
  });
  it("the hub peserta list does not include this flag for SEP (aggregates only)", async () => {
    await add();
    const hub = await getKepHub(sep, KEP);
    expect(hub.peserta).toBeUndefined();
    expect(hub.belumLengkap).toBe(0);
  });
});
