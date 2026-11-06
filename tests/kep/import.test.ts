import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import ExcelJS from "exceljs";
import { EVENT_ID_FIELD, F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, seedAccount, store } from "../helpers/fake-airtable";
import { HEADERS, emptyXlsx, goodRow, lyingZip, macroXlsm, validXlsx, vbaInPlainXlsx, xlsx, zip, zipBomb } from "./fixtures/build";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", async (orig) => ({ ...(await orig<object>()), invalidateKepCache: vi.fn() }));

import * as client from "@/lib/airtable/client";
import { neutralize } from "@/lib/security/csv";
import { ImportFileError, buildTemplateXlsx, parseImport } from "@/lib/kep/import";
import { GET as templateRoute } from "@/app/api/kep/[id]/import/template/route";
import { POST as previewRoute } from "@/app/api/kep/[id]/import/preview/route";
import { POST as commitRoute } from "@/app/api/kep/[id]/import/commit/route";
import { setMailer } from "@/lib/email";
import { SESSION_COOKIE, clearSessionCache, issueSession, type Session } from "@/lib/auth/session";
import { resetRateLimitMemory } from "@/lib/ratelimit";

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
const ADM_A: Session = { accountId: "recADMA000000001", email: "adma@x.id", role: "ADMIN", parokiId: PA };
let ip = 0;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const parokiByName = new Map([["pandu", PA]]);
const parse = (b: Buffer) => parseImport(b, { parokiByName });

async function post(handler: unknown, file: Buffer | null, o: { as?: Session; id?: string; headers?: Record<string, string>; ct?: string } = {}) {
  const fd = new FormData();
  if (file) fd.set("file", new Blob([new Uint8Array(file)]), "peserta.xlsx");
  const req = new Request("https://kep.test/api/kep/x/import", {
    method: "POST",
    headers: {
      "sec-fetch-site": "same-origin",
      "x-real-ip": `10.2.0.${++ip % 250}`,
      ...(o.as ? { cookie: `${SESSION_COOKIE}=${await issueSession(o.as, { amr: ["pwd", "otp"] })}` } : {}),
      ...o.headers,
    },
    body: fd,
  });
  return (handler as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve({ id: o.id ?? KEP }) });
}
async function get(handler: unknown, o: { as?: Session; id?: string } = {}) {
  const req = new Request("https://kep.test/api/kep/x/import/template", {
    headers: { "x-real-ip": `10.3.0.${++ip % 250}`, ...(o.as ? { cookie: `${SESSION_COOKIE}=${await issueSession(o.as, { amr: ["pwd", "otp"] })}` } : {}) },
  });
  return (handler as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve({ id: o.id ?? KEP }) });
}

function seed(status = "Disetujui") {
  store[T.paroki] = [
    { id: PA, fields: { [F.paroki.nama]: "Pandu" } },
    { id: PB, fields: { [F.paroki.nama]: "Katedral" } },
  ];
  store[T.penyelenggaraKep] = [
    { id: ORG, fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: ORG2, fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  store[T.events] = [
    { id: EV, fields: { [F.events.namaAcara]: "KEP PAROKI PANDU ANGKATAN 3", [EVENT_ID_FIELD]: "2026-12-01 KEP A" } },
    { id: EV2, fields: { [F.events.namaAcara]: "KEP PAROKI KATEDRAL ANGKATAN 1", [EVENT_ID_FIELD]: "2026-12-01 KEP B" } },
  ];
  store[T.eventKep] = [
    { id: KEP, fields: { [F.eventKep.events]: [EV], [F.eventKep.penyelenggara]: [ORG], [F.eventKep.statusPersetujuan]: status } },
    { id: KEP2, fields: { [F.eventKep.events]: [EV2], [F.eventKep.penyelenggara]: [ORG2], [F.eventKep.statusPersetujuan]: "Disetujui" } },
  ];
}
const pendaftaran = () => store[T.pendaftaranEvents] ?? [];
const audits = (aksi?: string) => (store[T.auditKep] ?? []).filter((a) => !aksi || a.fields[F.auditKep.aksi] === aksi);

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("MFA_ENC_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("APP_BASE_URL", "https://kep.example.org");
  resetStore();
  resetRateLimitMemory();
  clearSessionCache();
  vi.mocked(client.createRecords).mockClear();
  setMailer({ send: async () => {} });
  seed();
  await seedAccount({ id: PIC_A.accountId, email: PIC_A.email, peran: "PIC Paroki", fields: { [F.akunKep.paroki]: [PA] } });
  await seedAccount({ id: PIC_B.accountId, email: PIC_B.email, peran: "PIC Paroki", fields: { [F.akunKep.paroki]: [PB] } });
  await seedAccount({ id: ADM_A.accountId, email: ADM_A.email, peran: "Admin Paroki", fields: { [F.akunKep.paroki]: [PA] } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  setMailer(null);
});

describe("neutralize", () => {
  it("prefixes formula starters and tab/CR with a single quote", () => {
    expect(neutralize('=HYPERLINK("http://x","y")')).toBe(`'=HYPERLINK("http://x","y")`);
    for (const s of ["+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(neutralize(s)).toBe(`'${s}`);
  });
  it("leaves ordinary text alone", () => {
    expect(neutralize("Maria Goreti")).toBe("Maria Goreti");
    expect(neutralize("")).toBe("");
  });
});

describe("buildTemplateXlsx", () => {
  it("has the PesertaInput columns and one CONTOH example row that is rejected if left unchanged", async () => {
    const buf = await buildTemplateXlsx({ parokiNames: ["Pandu"] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(HEADERS);
    expect(String(ws.getRow(2).getCell(1).value)).toMatch(/^CONTOH/);
    const r = await parse(buf);
    expect(r.rows).toHaveLength(0);
    expect(r.errors[0].row).toBe(2);
    expect(r.errors[0].message).toMatch(/contoh/i);
  });
});

describe("parseImport", () => {
  it("parses a valid file", async () => {
    const r = await parse(await validXlsx(3));
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0].parokiAsalId).toBe(PA);
    expect(r.rows[0].wa).toBe("628123100001");
  });
  it("one bad row: rows are right and errors point to the spreadsheet row; blank rows are skipped", async () => {
    const buf = await xlsx([goodRow(1), {}, goodRow(2, { Email: "bukan-email" }), goodRow(3)]);
    const r = await parse(buf);
    expect(r.rows).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].row).toBe(4);
    expect(r.errors[0].message).toMatch(/email/i);
  });
  it("empty workbook: no rows, no errors", async () => {
    expect(await parse(await emptyXlsx())).toEqual({ rows: [], errors: [], items: [] });
  });
  it("health text without 'ya' is an error; with 'ya' it passes", async () => {
    const r = await parse(await xlsx([goodRow(1, { "Riwayat Alergi": "udang" }), goodRow(2, { "Riwayat Alergi": "udang", "Persetujuan Data Kesehatan": "ya" }), goodRow(3, { "Riwayat Alergi": "udang", "Persetujuan Data Kesehatan": "tidak" })]));
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.row)).toEqual([2, 4]);
  });
  it("formula-looking text is neutralized and formula cells are read as their text result, never evaluated", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Peserta");
    ws.addRow(HEADERS);
    const g = goodRow(1);
    ws.addRow(HEADERS.map((h) => g[h] ?? null));
    ws.getRow(2).getCell(7).value = "=HYPERLINK(\"http://evil\",\"x\")";
    ws.getRow(2).getCell(15).value = { formula: "1+1", result: "@cmd" } as ExcelJS.CellFormulaValue;
    ws.getRow(2).getCell(18).value = "ya";
    ws.getRow(2).getCell(2).value = { text: "Maria", hyperlink: "http://evil" } as ExcelJS.CellHyperlinkValue;
    ws.getRow(2).getCell(16).value = { richText: [{ text: "+ud" }, { text: "ang" }] };
    const r = await parse(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.errors).toEqual([]);
    expect(r.rows[0].alamat).toBe(`'=HYPERLINK("http://evil","x")`);
    expect(r.rows[0].riwayatPenyakit).toBe("'@cmd");
    expect(r.rows[0].riwayatAlergi).toBe("'+udang");
    expect(r.rows[0].namaBaptis).toBe("Maria");
  });
  it("Date cells and numeric WhatsApp cells are accepted", async () => {
    const r = await parse(await xlsx([goodRow(1, { "Tanggal Lahir": new Date(Date.UTC(1990, 4, 3)), "Nomor WhatsApp": 81234567890 })]));
    expect(r.errors).toEqual([]);
    expect(r.rows[0].tanggalLahir).toBe("1990-05-03");
    expect(r.rows[0].wa).toBe("6281234567890");
  });
  it("unknown paroki name is a row error", async () => {
    const r = await parse(await xlsx([goodRow(1, { "Paroki Asal": "Nowhere" })]));
    expect(r.errors[0].row).toBe(2);
    expect(r.errors[0].message).toMatch(/paroki/i);
  });
  it("rejects missing header columns", async () => {
    await expect(parse(await xlsx([goodRow(1)], { headers: HEADERS.slice(1) }))).rejects.toBeInstanceOf(ImportFileError);
  });
  it("rejects macro files (.xlsm content type and vbaProject.bin), non-zip, oversize, zip bombs, lying sizes", async () => {
    await expect(parse(macroXlsm())).rejects.toBeInstanceOf(ImportFileError);
    await expect(parse(await vbaInPlainXlsx())).rejects.toThrow(/makro/i);
    await expect(parse(Buffer.from("a,b,c\n1,2,3\n"))).rejects.toBeInstanceOf(ImportFileError);
    await expect(parse(Buffer.alloc(2 * 1024 * 1024 + 1, 1))).rejects.toMatchObject({ status: 413 });
    await expect(parse(zipBomb())).rejects.toBeInstanceOf(ImportFileError);
    await expect(parse(lyingZip())).rejects.toBeInstanceOf(ImportFileError);
    await expect(parse(zip([{ name: "x.txt", data: Buffer.from("x") }]))).rejects.toBeInstanceOf(ImportFileError);
  });
  it("rejects more than 500 data rows, accepts exactly 500", async () => {
    const mk = (n: number) => xlsx(Array.from({ length: n }, (_, i) => goodRow(i + 1)));
    await expect(parse(await mk(501))).rejects.toThrow(/500/);
    const ok = await parse(await mk(500));
    expect(ok.rows).toHaveLength(500);
  }, 60000);
});

describe("template route", () => {
  it("PIC of the parish downloads an xlsx; cross-parish 404; ADMIN 403; anonymous 401", async () => {
    const ok = await get(templateRoute, { as: PIC_A });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("spreadsheetml");
    expect(ok.headers.get("content-disposition")).toContain("attachment");
    expect((await get(templateRoute, { as: PIC_B })).status).toBe(404);
    expect((await get(templateRoute, { as: ADM_A })).status).toBe(403);
    expect((await get(templateRoute)).status).toBe(401);
  });
});

describe("preview route", () => {
  it("returns valid count and errors and writes nothing to the registration tables", async () => {
    const file = await xlsx([goodRow(1), goodRow(2, { Email: "x" }), goodRow(3)]);
    vi.mocked(client.createRecords).mockClear();
    const res = await post(previewRoute, file, { as: PIC_A });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.valid).toBe(2);
    expect(b.errors).toEqual([expect.objectContaining({ row: 3 })]);
    expect(b.sha256).toBe(sha(file));
    const tables = vi.mocked(client.createRecords).mock.calls.map((c) => c[0]);
    expect(tables.every((t) => t === T.auditKep)).toBe(true);
    expect(pendaftaran()).toHaveLength(0);
    expect(store[T.teamUmat] ?? []).toHaveLength(0);
    expect(audits("import_preview")).toHaveLength(1);
    expect(JSON.stringify(b)).not.toMatch(/peserta1@example/); // no echo of personal data
  });
  it("401, 403 non-PIC, 404 cross-parish, 409 KEP not Disetujui", async () => {
    const f = await validXlsx(1);
    expect((await post(previewRoute, f)).status).toBe(401);
    expect((await post(previewRoute, f, { as: ADM_A })).status).toBe(403);
    expect((await post(previewRoute, f, { as: PIC_B })).status).toBe(404);
    store[T.eventKep][0].fields[F.eventKep.statusPersetujuan] = "Diajukan";
    expect((await post(previewRoute, f, { as: PIC_A })).status).toBe(409);
  });
  it("same-origin guard: cross-site or missing signals are refused; JSON content type is not the contract", async () => {
    const f = await validXlsx(1);
    expect((await post(previewRoute, f, { as: PIC_A, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    const res = await post(previewRoute, f, { as: PIC_A, headers: { "sec-fetch-site": "", origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
  it("oversize by Content-Length is refused before reading the body (413)", async () => {
    const req = new Request("https://kep.test/x", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "multipart/form-data; boundary=x", "content-length": String(5 * 1024 * 1024), cookie: `${SESSION_COOKIE}=${await issueSession(PIC_A, { amr: ["pwd", "otp"] })}` },
      body: "x",
    });
    const res = await (previewRoute as unknown as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve({ id: KEP }) });
    expect(res.status).toBe(413);
  });
  it("oversize without a truthful Content-Length is capped while streaming (413)", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const res = await post(previewRoute, big, { as: PIC_A });
    expect(res.status).toBe(413);
  });
  it("non-xlsx, missing file and macro files are 422/400", async () => {
    expect((await post(previewRoute, Buffer.from("hello"), { as: PIC_A })).status).toBe(422);
    expect((await post(previewRoute, null, { as: PIC_A })).status).toBe(400);
    expect((await post(previewRoute, macroXlsm(), { as: PIC_A })).status).toBe(422);
  });
  it("is rate limited per account", async () => {
    const f = await validXlsx(1);
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await post(previewRoute, f, { as: PIC_A })).status;
    expect(last).toBe(429);
  });
});

describe("commit route", () => {
  it("registers valid rows, reports row numbers for invalid ones, audits start/done with hash and counts only", async () => {
    const file = await xlsx([goodRow(1), goodRow(2, { Email: "x" }), goodRow(3)]);
    const res = await post(commitRoute, file, { as: PIC_A });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b).toMatchObject({ registered: 2, alreadyRegistered: 0, failed: 1 });
    expect(b.failedRows).toEqual([expect.objectContaining({ row: 3 })]);
    expect(pendaftaran()).toHaveLength(2);
    const start = audits("import_peserta_mulai");
    const done = audits("import_peserta_selesai");
    expect(start).toHaveLength(1);
    expect(done).toHaveLength(1);
    const dump = JSON.stringify([...start, ...done]);
    expect(dump).toContain(sha(file));
    expect(dump).not.toMatch(/example\.com|Maria/);
  });
  it("people who are already registered count as alreadyRegistered", async () => {
    const file = await validXlsx(2);
    await post(commitRoute, file, { as: PIC_A });
    // a different file (new hash) with the same two people
    const again = await xlsx([goodRow(1), goodRow(2), {}]);
    const b = await (await post(commitRoute, again, { as: PIC_A })).json();
    expect(b).toMatchObject({ registered: 0, alreadyRegistered: 2, failed: 0 });
    expect(pendaftaran()).toHaveLength(2);
  });
  it("is idempotent per (kep, file hash): a double click does not register or write again", async () => {
    const file = await validXlsx(3);
    const [a, b] = await Promise.all([post(commitRoute, file, { as: PIC_A }), post(commitRoute, file, { as: PIC_A })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(pendaftaran()).toHaveLength(3);
    const c = await post(commitRoute, file, { as: PIC_A });
    const body = await c.json();
    expect(body).toMatchObject({ registered: 3, ulang: true });
    expect(pendaftaran()).toHaveLength(3);
    expect(audits("import_peserta_selesai")).toHaveLength(1);
  });
  it("uses the re-parsed upload: client-sent parsed rows are ignored", async () => {
    const fd = new FormData();
    fd.set("file", new Blob([new Uint8Array(await validXlsx(1))]), "p.xlsx");
    fd.set("rows", JSON.stringify([goodRow(99)]));
    const req = new Request("https://kep.test/x", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "x-real-ip": "10.9.9.9", cookie: `${SESSION_COOKIE}=${await issueSession(PIC_A, { amr: ["pwd", "otp"] })}` },
      body: fd,
    });
    const res = await (commitRoute as unknown as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve({ id: KEP }) });
    expect((await res.json()).registered).toBe(1);
    expect(pendaftaran()).toHaveLength(1);
  });
  it("401, 403 non-PIC, 404 cross-parish, 409 not Disetujui, nothing written", async () => {
    const f = await validXlsx(1);
    expect((await post(commitRoute, f)).status).toBe(401);
    expect((await post(commitRoute, f, { as: ADM_A })).status).toBe(403);
    expect((await post(commitRoute, f, { as: PIC_B })).status).toBe(404);
    store[T.eventKep][0].fields[F.eventKep.statusPersetujuan] = "Diajukan";
    expect((await post(commitRoute, f, { as: PIC_A })).status).toBe(409);
    expect(pendaftaran()).toHaveLength(0);
  });
  it("a failing row does not stop the batch and is reported without PII", async () => {
    const real = vi.mocked(client.createRecords).getMockImplementation()!;
    const file = await xlsx([goodRow(1), goodRow(2)]);
    let failedOnce = false;
    vi.mocked(client.createRecords).mockImplementation(async (t, r, e) => {
      if (t === T.pendaftaranEvents && !failedOnce) {
        failedOnce = true;
        throw new Error("Airtable request failed: HTTP 500 maria@x");
      }
      return real(t, r, e);
    });
    const res = await post(commitRoute, file, { as: PIC_A });
    vi.mocked(client.createRecords).mockImplementation(real);
    const b = await res.json();
    expect(b.registered + b.failed).toBe(2);
    expect(b.failed).toBe(1);
    expect(JSON.stringify(b)).not.toMatch(/maria@x|Airtable/);
  });
});
