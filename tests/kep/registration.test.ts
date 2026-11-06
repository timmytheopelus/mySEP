import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { F, T, PENDAFTARAN_CREATED, EVENT_ID_FIELD } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
const invalidate = vi.fn();
vi.mock("@/lib/kep/readModel", async (orig) => ({ ...(await orig<object>()), invalidateKepCache: (...a: unknown[]) => invalidate(...a) }));

import * as client from "@/lib/airtable/client";
import {
  PesertaInput,
  RegistrationClosedError,
  findOrCreatePerson,
  normalizeWa,
  registerPeserta,
  signRegistrationToken,
  verifyRegistrationToken,
} from "@/lib/kep/registration";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { renderTemplate } from "@/lib/email/templates";
import { setMailer } from "@/lib/email";
import { SESSION_COOKIE, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { resetRateLimitMemory } from "@/lib/ratelimit";
import { POST as publicRoute } from "@/app/api/daftar/[token]/route";
import { POST as manualRoute } from "@/app/api/kep/[id]/peserta/route";

const P = F.pendaftaranEvents;
const U = F.teamUmat;
const EV = "recEVENT000000001";
const EV2 = "recEVENT000000002";
const KEP = "recKEP00000000001";
const KEP2 = "recKEP00000000002";
const ORG = "recORG00000000001";
const ORG2 = "recORG00000000002";
const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const PIC_A: Session = { accountId: "recPICA000000001", email: "pica@x.id", role: "PIC", parokiId: PA };
const PIC_B: Session = { accountId: "recPICB000000001", email: "picb@x.id", role: "PIC", parokiId: PB };

const mails: { to: string; template: string; data: Record<string, unknown> }[] = [];
let ip = 0;

const valid = (over: Record<string, unknown> = {}) => ({
  namaLengkap: "Maria Goreti",
  namaBaptis: "Maria",
  jenisKelamin: "Wanita",
  tanggalLahir: "1985-04-12",
  wa: "0812-3456-789",
  email: "Maria@Example.com",
  alamat: "Jl. Merdeka 1, Bandung",
  parokiAsalId: PA,
  statusPernikahan: "Menikah",
  kontakDarurat: "Yohanes 081111111111",
  pendukungDoa: [
    { nama: "Ana", kontak: "081200000001" },
    { nama: "Budi", kontak: "081200000002" },
  ],
  riwayatPenyakit: "RAHASIA-DIABETES",
  riwayatAlergi: "RAHASIA-UDANG",
  obatRutin: "RAHASIA-METFORMIN",
  ...over,
});

const pendaftaran = () => store[T.pendaftaranEvents] ?? [];
const active = () => pendaftaran().filter((r) => r.fields[P.statusPendaftaran] !== "Batal");
const persons = () => store[T.teamUmat] ?? [];

function seedKep(status = "Disetujui", opts: { selesai?: string } = {}) {
  store[T.paroki] = [
    { id: PA, fields: { [F.paroki.nama]: "Pandu" } },
    { id: PB, fields: { [F.paroki.nama]: "Katedral" } },
  ];
  store[T.penyelenggaraKep] = [
    { id: ORG, fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: ORG2, fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  store[T.events] = [
    { id: EV, fields: { [F.events.namaAcara]: "KEP PAROKI PANDU ANGKATAN 3", [EVENT_ID_FIELD]: "2026-12-01 KEP PAROKI PANDU ANGKATAN 3" } },
    { id: EV2, fields: { [F.events.namaAcara]: "KEP PAROKI KATEDRAL ANGKATAN 1", [EVENT_ID_FIELD]: "2026-12-01 KEP PAROKI KATEDRAL ANGKATAN 1" } },
  ];
  store[T.eventKep] = [
    {
      id: KEP,
      fields: {
        [F.eventKep.events]: [EV],
        [F.eventKep.penyelenggara]: [ORG],
        [F.eventKep.statusPersetujuan]: status,
        ...(opts.selesai ? { [F.eventKep.tanggalSelesai]: opts.selesai } : {}),
      },
    },
    { id: KEP2, fields: { [F.eventKep.events]: [EV2], [F.eventKep.penyelenggara]: [ORG2], [F.eventKep.statusPersetujuan]: "Disetujui" } },
  ];
}

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("REG_TOKEN_SECRET", "r".repeat(48));
  vi.stubEnv("TURNSTILE_SECRET", "turnstile-secret");
  vi.stubEnv("APP_BASE_URL", "https://kep.example.org");
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  invalidate.mockClear();
  vi.mocked(client.createRecords).mockClear();
  mails.length = 0;
  setMailer({ send: async (to, template, data) => void mails.push({ to, template, data: data as Record<string, unknown> }) });
  seedKep();
  await seedAccount({ id: PIC_A.accountId, email: PIC_A.email, peran: "PIC Paroki", fields: { [F.akunKep.paroki]: [PA] } });
  await seedAccount({ id: PIC_B.accountId, email: PIC_B.email, peran: "PIC Paroki", fields: { [F.akunKep.paroki]: [PB] } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setMailer(null);
});

describe("normalizeWa", () => {
  it("maps 0812-..., +62 812 ..., 62 812-... to the same 62812... value", () => {
    expect(normalizeWa("0812-3456-789")).toBe("62812345 6789".replace(" ", ""));
    expect(normalizeWa("+62 812 3456 789")).toBe("628123456789");
    expect(normalizeWa("62 812-3456-789")).toBe("628123456789");
    expect(normalizeWa("+62 0812 3456 789")).toBe("628123456789");
  });
  it("rejects junk and non-mobile numbers", () => {
    expect(normalizeWa("abc")).toBeNull();
    expect(normalizeWa("")).toBeNull();
    expect(normalizeWa("12345")).toBeNull();
    expect(normalizeWa("+1 555 123 4567")).toBeNull();
  });
});

describe("registration token", () => {
  it("round-trips the event id", () => {
    expect(verifyRegistrationToken(signRegistrationToken(EV))).toEqual({ eventId: EV });
  });
  it("returns null for modified payload, modified signature, other secret, garbage", () => {
    const t = signRegistrationToken(EV);
    const [p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ e: EV2, v: 1 })).toString("base64url");
    expect(verifyRegistrationToken(`${forged}.${s}`)).toBeNull();
    expect(verifyRegistrationToken(`${p}.${s.slice(0, -2)}AA`)).toBeNull();
    expect(verifyRegistrationToken(`${p}.`)).toBeNull();
    expect(verifyRegistrationToken("x")).toBeNull();
    expect(verifyRegistrationToken("a.b.c")).toBeNull();
    expect(verifyRegistrationToken("")).toBeNull();
    vi.stubEnv("REG_TOKEN_SECRET", "z".repeat(48));
    expect(verifyRegistrationToken(t)).toBeNull();
  });
  it("refuses to sign or verify with a secret shorter than 32 bytes", () => {
    const t = signRegistrationToken(EV);
    vi.stubEnv("REG_TOKEN_SECRET", "short");
    expect(() => signRegistrationToken(EV)).toThrow();
    expect(verifyRegistrationToken(t)).toBeNull();
    vi.stubEnv("REG_TOKEN_SECRET", "");
    expect(verifyRegistrationToken(t)).toBeNull();
  });
  it("only signs well-formed record ids", () => {
    expect(() => signRegistrationToken("not an id")).toThrow();
  });
  it("carries no personal data: payload is the event id and a version only", () => {
    const payload = JSON.parse(Buffer.from(signRegistrationToken(EV).split(".")[0], "base64url").toString());
    expect(Object.keys(payload).sort()).toEqual(["e", "v"]);
  });
});

describe("PesertaInput validation", () => {
  it("accepts a valid body and normalizes wa and email", () => {
    const r = PesertaInput.parse(valid());
    expect(r.wa).toBe("628123456789");
    expect(r.email).toBe("maria@example.com");
  });
  it("requires exactly two pendukungDoa", () => {
    expect(PesertaInput.safeParse(valid({ pendukungDoa: [{ nama: "Ana", kontak: "0812000000" }] })).success).toBe(false);
    expect(PesertaInput.safeParse(valid({ pendukungDoa: [] })).success).toBe(false);
    const three = [1, 2, 3].map((i) => ({ nama: `N${i}x`, kontak: "0812000000" }));
    expect(PesertaInput.safeParse(valid({ pendukungDoa: three })).success).toBe(false);
  });
  it("requires a valid email, a usable wa and a plausible birth date", () => {
    expect(PesertaInput.safeParse(valid({ email: "" })).success).toBe(false);
    expect(PesertaInput.safeParse(valid({ email: undefined })).success).toBe(false);
    expect(PesertaInput.safeParse(valid({ email: "a@b" })).success).toBe(false);
    expect(PesertaInput.safeParse(valid({ email: "a@b.id\r\nBcc: x@y.id" })).success).toBe(false);
    expect(PesertaInput.safeParse(valid({ wa: "abc" })).success).toBe(false);
    expect(PesertaInput.safeParse(valid({ tanggalLahir: "2999-01-01" })).success).toBe(false);
    expect(PesertaInput.safeParse(valid({ tanggalLahir: "1850-01-01" })).success).toBe(false);
    expect(PesertaInput.safeParse(valid({ tanggalLahir: "1985-02-30" })).success).toBe(false);
  });
  it("caps lengths and rejects control characters in names", () => {
    expect(PesertaInput.safeParse(valid({ namaLengkap: "A".repeat(500) })).success).toBe(false);
    expect(PesertaInput.safeParse(valid({ namaLengkap: "Maria\r\nBcc: evil@x.id" })).success).toBe(false);
    expect(PesertaInput.safeParse(valid({ riwayatPenyakit: "x".repeat(5000) })).success).toBe(false);
  });
  it("strips unknown keys such as jabatanBPK", () => {
    const r = PesertaInput.parse(valid({ jabatanBPK: "Koordinator", statusPendaftaran: "Confirmed", admin: true }));
    expect(Object.keys(r)).not.toContain("jabatanBPK");
    expect(Object.keys(r)).not.toContain("statusPendaftaran");
    expect(Object.keys(r)).not.toContain("admin");
  });
});

describe("findOrCreatePerson", () => {
  it("the same person with a differently formatted WA does not create a second TeamUmat row", async () => {
    const a = await findOrCreatePerson(PesertaInput.parse(valid({ wa: "0812-3456-789", email: "a1@x.id" })));
    const b = await findOrCreatePerson(PesertaInput.parse(valid({ wa: "+62 812 3456 789", email: "a2@x.id" })));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.personId).toBe(a.personId);
    expect(persons()).toHaveLength(1);
  });
  it("matches on lowercased email", async () => {
    const a = await findOrCreatePerson(PesertaInput.parse(valid({ wa: "081211110001", email: "Same@X.id" })));
    const b = await findOrCreatePerson(PesertaInput.parse(valid({ wa: "081211110002", email: "sAme@x.ID" })));
    expect(b.personId).toBe(a.personId);
    expect(persons()).toHaveLength(1);
  });
  it("never overwrites non-empty fields nor email/WA of an existing person; only fills blanks", async () => {
    store[T.teamUmat] = [
      {
        id: "recPERSON0000001",
        fields: { [U.namaLengkap]: "Maria Asli", [U.email]: "asli@x.id", [U.noWhatsapp]: "6281234567890".slice(0, 12), [U.alamatTinggal]: "Alamat Lama" },
      },
    ];
    const wa = "628123456789";
    store[T.teamUmat][0].fields[U.noWhatsapp] = wa;
    const r = await findOrCreatePerson(PesertaInput.parse(valid({ namaLengkap: "Penyerang", wa: "0812-3456-789", email: "penyerang@evil.id", alamat: "Alamat Baru" })));
    expect(r).toEqual({ personId: "recPERSON0000001", created: false });
    const f = persons()[0].fields;
    expect(f[U.namaLengkap]).toBe("Maria Asli");
    expect(f[U.email]).toBe("asli@x.id");
    expect(f[U.noWhatsapp]).toBe(wa);
    expect(f[U.alamatTinggal]).toBe("Alamat Lama");
    expect(f[U.tanggalLahir]).toBe("1985-04-12"); // blank -> filled
    expect(f[U.jenisKelamin]).toBe("Wanita");
  });
  it("WA and email pointing at two different persons: no merge, WA match wins, conflict is audited", async () => {
    store[T.teamUmat] = [
      { id: "recPERSONWA00001", fields: { [U.namaLengkap]: "Orang WA", [U.noWhatsapp]: "628123456789" } },
      { id: "recPERSONEM00001", fields: { [U.namaLengkap]: "Orang Email", [U.email]: "maria@example.com" } },
    ];
    const r = await registerPeserta(EV, PesertaInput.parse(valid()));
    expect(r.status).toBe("registered");
    expect(pendaftaran()[0].fields[P.teamUmat]).toEqual(["recPERSONWA00001"]);
    expect(persons()).toHaveLength(2);
    expect(persons().find((p) => p.id === "recPERSONEM00001")!.fields).toEqual({ [U.namaLengkap]: "Orang Email", [U.email]: "maria@example.com" });
    const audit = store[T.auditKep] ?? [];
    expect(audit.some((a) => a.fields[F.auditKep.aksi] === "registrasi_konflik_identitas")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("RAHASIA");
  });
});

describe("registerPeserta", () => {
  it("registers an approved KEP with Kategori Peserta, Status Daftar and invalidates the cache", async () => {
    const r = await registerPeserta(EV, PesertaInput.parse(valid()));
    expect(r.status).toBe("registered");
    const row = pendaftaran()[0];
    expect(row.id).toBe(r.pendaftaranId);
    expect(row.fields[P.event]).toEqual([EV]);
    expect(row.fields[P.kategoriKepesertaan]).toBe("Peserta");
    expect(row.fields[P.statusPendaftaran]).toBe("Daftar");
    expect(row.fields[P.pendukungDoa]).toContain("Ana");
    expect(row.fields[P.pendukungDoa]).toContain("Budi");
    expect(row.fields[P.riwayatPenyakit]).toBe("RAHASIA-DIABETES");
    expect(invalidate).toHaveBeenCalled();
  });
  it("refuses a KEP that is not Disetujui (Diajukan, Ditolak, empty) and writes nothing", async () => {
    for (const status of ["Diajukan", "Ditolak", ""]) {
      seedKep(status);
      await expect(registerPeserta(EV, PesertaInput.parse(valid()))).rejects.toBeInstanceOf(RegistrationClosedError);
    }
    expect(pendaftaran()).toHaveLength(0);
    expect(persons()).toHaveLength(0);
  });
  it("refuses a KEP whose end date is long past, unknown events and malformed ids", async () => {
    seedKep("Disetujui", { selesai: "2020-01-01" });
    await expect(registerPeserta(EV, PesertaInput.parse(valid()))).rejects.toBeInstanceOf(RegistrationClosedError);
    seedKep();
    await expect(registerPeserta("recNOSUCHEVENT001", PesertaInput.parse(valid()))).rejects.toBeInstanceOf(RegistrationClosedError);
    await expect(registerPeserta("bogus", PesertaInput.parse(valid()))).rejects.toBeInstanceOf(RegistrationClosedError);
  });
  it("a second registration of the same person (other WA format) is already_registered without a new row", async () => {
    const a = await registerPeserta(EV, PesertaInput.parse(valid({ wa: "0812-3456-789" })));
    const b = await registerPeserta(EV, PesertaInput.parse(valid({ wa: "+62 812 3456 789", email: "other@x.id" })));
    expect(b.status).toBe("already_registered");
    expect(b.pendaftaranId).toBe(a.pendaftaranId);
    expect(pendaftaran()).toHaveLength(1);
    expect(persons()).toHaveLength(1);
  });
  it("a Batal registration does not block a new one", async () => {
    const a = await registerPeserta(EV, PesertaInput.parse(valid()));
    pendaftaran()[0].fields[P.statusPendaftaran] = "Batal";
    const b = await registerPeserta(EV, PesertaInput.parse(valid()));
    expect(b.status).toBe("registered");
    expect(b.pendaftaranId).not.toBe(a.pendaftaranId);
  });
  it("the same person may register for another KEP", async () => {
    await registerPeserta(EV, PesertaInput.parse(valid()));
    const b = await registerPeserta(EV2, PesertaInput.parse(valid()));
    expect(b.status).toBe("registered");
    expect(pendaftaran()).toHaveLength(2);
  });
  it("mass assignment: only the public allowlist reaches Airtable (no jabatan, no admin fields)", async () => {
    const body = valid({
      jabatanBPK: "Koordinator",
      [U.namaLengkap]: "X",
      [F.teamUmat.paroki]: ["recEVIL0000000001"],
      "fldT3yUTrEgCuOwbm": "Koordinator",
      "fldAkafSwLI9ids0d": "Sekretaris",
      [P.statusPendaftaran]: "Confirmed",
      "fldqB6h9rzzC5VhKI": true,
    });
    await registerPeserta(EV, PesertaInput.parse(body));
    const allowedTeam = new Set<string>(Object.values(U));
    const allowedPend = new Set<string>([P.event, P.teamUmat, P.kategoriKepesertaan, P.statusPendaftaran, P.pendukungDoa, P.kontakDarurat, P.riwayatPenyakit, P.riwayatAlergi, P.obatRutin]);
    for (const k of Object.keys(persons()[0].fields)) expect(allowedTeam.has(k)).toBe(true);
    for (const k of Object.keys(pendaftaran()[0].fields)) expect(allowedPend.has(k)).toBe(true);
    expect(persons()[0].fields).not.toHaveProperty("fldAkafSwLI9ids0d");
    expect(persons()[0].fields).not.toHaveProperty("fldT3yUTrEgCuOwbm");
    expect(persons()[0].fields[U.paroki]).toEqual([PA]);
    expect(pendaftaran()[0].fields[P.statusPendaftaran]).toBe("Daftar");
    // every createRecords/updateRecords call by the module carried only schema-known ids
    for (const c of vi.mocked(client.createRecords).mock.calls) {
      for (const row of c[1]) for (const k of Object.keys(row)) expect(k).toMatch(/^fld/);
    }
  });
  it("rejects a parokiAsalId that is not a real paroki", async () => {
    await expect(registerPeserta(EV, PesertaInput.parse(valid({ parokiAsalId: "recNOPAROKI000001" })))).rejects.toThrow();
    expect(persons()).toHaveLength(0);
  });
  it("sends the confirmation email exactly once, with escaped content and no health data", async () => {
    await registerPeserta(EV, PesertaInput.parse(valid({ namaLengkap: "Maria <script>alert(1)</script>" })));
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("maria@example.com");
    expect(mails[0].template).toBe("pendaftaran_kep");
    const rendered = renderTemplate("pendaftaran_kep", mails[0].data as never);
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    const all = JSON.stringify(mails) + rendered.html + rendered.text;
    expect(all).not.toContain("RAHASIA");
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });
  it("already_registered also sends exactly one email; one that proves email ownership says so, others stay neutral", async () => {
    await registerPeserta(EV, PesertaInput.parse(valid()));
    mails.length = 0;
    await registerPeserta(EV, PesertaInput.parse(valid()));
    expect(mails).toHaveLength(1);
    expect((mails[0].data as { jenis?: string }).jenis).toBe("sudah_terdaftar");
    mails.length = 0;
    await registerPeserta(EV, PesertaInput.parse(valid({ email: "stranger@x.id" })));
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("stranger@x.id");
    expect((mails[0].data as { jenis?: string }).jenis).toBe("diterima"); // does not reveal the existing registration
  });
  it("an email failure keeps the registration and a retry creates no second row", async () => {
    setMailer({ send: async () => { throw new Error("smtp down"); } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await registerPeserta(EV, PesertaInput.parse(valid()));
    expect(a.status).toBe("registered");
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).not.toContain("RAHASIA");
    expect(logged).not.toContain("maria@example.com");
    err.mockRestore();
    setMailer({ send: async (to, template, data) => void mails.push({ to, template, data: data as Record<string, unknown> }) });
    const b = await registerPeserta(EV, PesertaInput.parse(valid()));
    expect(b.status).toBe("already_registered");
    expect(pendaftaran()).toHaveLength(1);
  });
  it("two simultaneous identical registrations leave one active row", async () => {
    const [a, b] = await Promise.all([registerPeserta(EV, PesertaInput.parse(valid())), registerPeserta(EV, PesertaInput.parse(valid()))]);
    expect([a.status, b.status].sort()).toEqual(["already_registered", "registered"]);
    expect(active()).toHaveLength(1);
    expect(persons()).toHaveLength(1);
    expect(a.pendaftaranId).toBe(b.pendaftaranId);
  });
  it("cross-process race: a rival row created first wins; ours is marked Batal (never deleted)", async () => {
    const real = vi.mocked(client.createRecords).getMockImplementation()!;
    vi.mocked(client.createRecords).mockImplementationOnce(async (...args: Parameters<typeof client.createRecords>) => {
      // person row is created first by the normal path
      return real(...args);
    });
    vi.mocked(client.createRecords).mockImplementationOnce(async (table, rows, extra) => {
      const out = await real(table, rows, extra);
      if (table === T.pendaftaranEvents) {
        const personId = (rows[0][P.teamUmat] as string[])[0];
        store[T.pendaftaranEvents].push({
          id: "recRIVAL000000001",
          fields: { [P.event]: [EV], [P.teamUmat]: [personId], [P.statusPendaftaran]: "Daftar", [PENDAFTARAN_CREATED]: "2000-01-01T00:00:00.000Z" },
        });
        out[0].fields[PENDAFTARAN_CREATED] = "2000-01-01T00:00:01.000Z";
        store[T.pendaftaranEvents].find((r) => r.id === out[0].id)!.fields[PENDAFTARAN_CREATED] = "2000-01-01T00:00:01.000Z";
      }
      return out;
    });
    const r = await registerPeserta(EV, PesertaInput.parse(valid()));
    expect(r.status).toBe("already_registered");
    expect(r.pendaftaranId).toBe("recRIVAL000000001");
    expect(pendaftaran()).toHaveLength(2);
    expect(active()).toHaveLength(1);
    expect(pendaftaran().find((x) => x.id !== "recRIVAL000000001")!.fields[P.statusPendaftaran]).toBe("Batal");
  });
  it("never logs health data", async () => {
    const spies = (["log", "warn", "error", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await registerPeserta(EV, PesertaInput.parse(valid()));
    await registerPeserta(EV, PesertaInput.parse(valid()));
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("RAHASIA");
    spies.forEach((s) => s.mockRestore());
  });
});

describe("verifyTurnstile", () => {
  it("posts the secret server-side and accepts only success:true", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ success: true })));
    vi.stubGlobal("fetch", f);
    expect(await verifyTurnstile("tok", "1.2.3.4")).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(String(init.body)).toContain("secret=turnstile-secret");
    expect(String(init.body)).toContain("response=tok");
  });
  it("fails closed: success:false, non-200, network error, missing secret, empty token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }))));
    expect(await verifyTurnstile("tok", "ip")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    expect(await verifyTurnstile("tok", "ip")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    expect(await verifyTurnstile("tok", "ip")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }))));
    expect(await verifyTurnstile("", "ip")).toBe(false);
    vi.stubEnv("TURNSTILE_SECRET", "");
    expect(await verifyTurnstile("tok", "ip")).toBe(false);
  });
});

async function callPublic(body: unknown, o: { token?: string; ip?: string; headers?: Record<string, string> } = {}) {
  const token = o.token ?? signRegistrationToken(EV);
  const req = new Request(`https://kep.test/api/daftar/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-real-ip": o.ip ?? `10.2.0.${++ip % 250}`, ...o.headers },
    body: JSON.stringify(body),
  });
  return publicRoute(req, { params: Promise.resolve({ token }) });
}
const captchaOk = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }))));
const withCaptcha = (b: Record<string, unknown> = {}) => ({ ...valid(), turnstileToken: "ok-token", ...b });

describe("POST /api/daftar/[token]", () => {
  it("captcha failure -> 400 and nothing is written", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }))));
    const res = await callPublic(withCaptcha());
    expect(res.status).toBe(400);
    expect(store[T.pendaftaranEvents]).toBeUndefined();
    expect(store[T.teamUmat]).toBeUndefined();
    expect(mails).toHaveLength(0);
  });
  it("captcha network error fails closed (400, no writes)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    const res = await callPublic(withCaptcha());
    expect(res.status).toBe(400);
    expect(store[T.pendaftaranEvents]).toBeUndefined();
  });
  it("missing captcha token -> 400", async () => {
    captchaOk();
    const b: Record<string, unknown> = withCaptcha();
    delete b.turnstileToken;
    expect((await callPublic(b)).status).toBe(400);
    expect(store[T.pendaftaranEvents]).toBeUndefined();
  });
  it("registered and already_registered answer identically (status, body) and never leak health data", async () => {
    captchaOk();
    const a = await callPublic(withCaptcha());
    const b = await callPublic(withCaptcha());
    const c = await callPublic(withCaptcha({ email: "someone.else@x.id" }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    const ta = await a.text();
    expect(await b.text()).toBe(ta);
    expect(await c.text()).toBe(ta);
    expect(ta).toContain("Terima kasih, konfirmasi dikirim ke email Anda");
    expect(ta).not.toMatch(/RAHASIA|rec[A-Za-z0-9]{10,}|already|registered/i);
    expect(pendaftaran()).toHaveLength(1);
    expect(mails).toHaveLength(3);
  });
  it("tampered token, unknown event and non-approved KEP all answer the same 404", async () => {
    captchaOk();
    seedKep("Diajukan");
    const closed = await callPublic(withCaptcha());
    const t = signRegistrationToken(EV);
    const bad = await callPublic(withCaptcha(), { token: t.slice(0, -3) + "AAA" });
    const unknown = await callPublic(withCaptcha(), { token: signRegistrationToken("recNOSUCHEVENT001") });
    expect(closed.status).toBe(404);
    expect(bad.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await bad.clone().text()).toBe(await closed.text());
    expect(await unknown.text()).toBe(await bad.clone().text());
    expect(store[T.pendaftaranEvents]).toBeUndefined();
  });
  it("validation errors -> 422 in Indonesian, nothing written; mass-assigned fields are ignored", async () => {
    captchaOk();
    const res = await callPublic(withCaptcha({ pendukungDoa: [{ nama: "Ana", kontak: "0812000000" }] }));
    expect(res.status).toBe(422);
    expect(store[T.pendaftaranEvents]).toBeUndefined();
    const ok = await callPublic(withCaptcha({ jabatanBPK: "Koordinator", statusPendaftaran: "Confirmed" }));
    expect(ok.status).toBe(200);
    expect(pendaftaran()[0].fields[P.statusPendaftaran]).toBe("Daftar");
  });
  it("the 11th registration attempt from one IP within the hour -> 429", async () => {
    captchaOk();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await callPublic(withCaptcha({ email: `u${i}@x.id`, wa: `08121111${String(1000 + i)}` }), { ip: "9.9.9.9" });
      last = res.status;
      if (i < 10) expect(res.status).toBe(200);
    }
    expect(last).toBe(429);
  });
  it("per-email limit: the same email cannot trigger unlimited mails from different IPs", async () => {
    captchaOk();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await callPublic(withCaptcha(), { ip: `8.8.8.${i}` })).status);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes).toContain(429);
    expect(mails.length).toBeLessThanOrEqual(3);
  });
  it("rejects non-JSON and cross-site posts (CSRF guard)", async () => {
    captchaOk();
    const t = signRegistrationToken(EV);
    const res = await publicRoute(
      new Request("https://kep.test/x", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" }),
      { params: Promise.resolve({ token: t }) },
    );
    expect(res.status).toBe(403);
  });
});

async function callManual(kepId: string, body: unknown, as?: Session) {
  const req = new Request(`https://kep.test/api/kep/${kepId}/peserta`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-real-ip": `10.3.0.${++ip % 250}`,
      ...(as ? { cookie: `${SESSION_COOKIE}=${await issueSession(as, { amr: ["pwd", "otp"] })}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return manualRoute(req, { params: Promise.resolve({ id: kepId }) });
}

describe("POST /api/kep/[id]/peserta (manual)", () => {
  it("401 without a session", async () => {
    expect((await callManual(KEP, valid())).status).toBe(401);
  });
  it("PIC of the owning paroki registers without a captcha; repeat is already_registered", async () => {
    const a = await callManual(KEP, valid(), PIC_A);
    expect(a.status).toBe(201);
    expect((await a.json()).status).toBe("registered");
    const b = await callManual(KEP, valid({ wa: "+62 812 3456 789" }), PIC_A);
    expect(b.status).toBe(200);
    expect((await b.json()).status).toBe("already_registered");
    expect(pendaftaran()).toHaveLength(1);
  });
  it("a PIC of another paroki gets 404 and nothing is written", async () => {
    const res = await callManual(KEP, valid(), PIC_B);
    expect(res.status).toBe(404);
    expect(store[T.pendaftaranEvents]).toBeUndefined();
  });
  it("a KEP that is not Disetujui is refused (409) even for its own PIC", async () => {
    seedKep("Diajukan");
    const res = await callManual(KEP, valid(), PIC_A);
    expect(res.status).toBe(409);
    expect(store[T.pendaftaranEvents]).toBeUndefined();
  });
  it("mass assignment is ignored and invalid bodies give 422", async () => {
    const ok = await callManual(KEP, valid({ jabatanBPK: "Koordinator", statusPendaftaran: "Confirmed" }), PIC_A);
    expect(ok.status).toBe(201);
    expect(pendaftaran()[0].fields[P.statusPendaftaran]).toBe("Daftar");
    expect((await callManual(KEP, valid({ email: "" }), PIC_A)).status).toBe(422);
  });
  it("malformed kep id -> 404", async () => {
    expect((await callManual("nope", valid(), PIC_A)).status).toBe(404);
  });
});
