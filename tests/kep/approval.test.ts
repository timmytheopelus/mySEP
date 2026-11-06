import { beforeEach, describe, expect, it, vi } from "vitest";
import { F, RESTRICTED, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn() }));

import * as client from "@/lib/airtable/client";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { decideKep, listKepQueue } from "@/lib/kep/approval";
import { logAudit } from "@/lib/audit/log";
import { setMailer } from "@/lib/email";
import { renderTemplate } from "@/lib/email/templates";
import type { Session } from "@/lib/auth/session";

const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const KEP = "recKEPA0000000001";
const KEPB = "recKEPB0000000001";
const EV = "recEVA00000000001";
const EVB = "recEVB00000000001";
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const picA: Session = { accountId: "recPICA000000001", email: "pica@x.id", role: "PIC", parokiId: PA };
const admA: Session = { accountId: "recADMA000000001", email: "adma@x.id", role: "ADMIN", parokiId: PA };
const rows = (t: string) => store[t] ?? [];
const kepRow = (id = KEP) => rows(T.eventKep).find((r) => r.id === id)!;
let sent: { to: string; template: string; data: Record<string, unknown> }[];

const acc = (id: string, email: string, peran: string, paroki: string, aktif = true) => ({
  id,
  fields: { [F.akunKep.email]: email, [F.akunKep.peran]: peran, [F.akunKep.paroki]: [paroki], [F.akunKep.statusAktif]: aktif },
});

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  sent = [];
  setMailer({ send: async (to, template, data) => void sent.push({ to, template, data: data as never }) });
  store[T.paroki] = [
    { id: PA, fields: { [F.paroki.nama]: "Pandu" } },
    { id: PB, fields: { [F.paroki.nama]: "Katedral" } },
  ];
  store[T.penyelenggaraKep] = [
    { id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: "recORGB0000000001", fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  store[T.events] = [
    { id: EV, fields: { [F.events.namaAcara]: "KEP PAROKI PANDU <b>ANGKATAN</b> 9", [F.events.tanggalAcara]: "2027-01-10" } },
    { id: EVB, fields: { [F.events.namaAcara]: "KEP PAROKI KATEDRAL ANGKATAN 2" } },
  ];
  store[T.eventKep] = [
    { id: KEP, fields: { [F.eventKep.statusPersetujuan]: "Diajukan", [F.eventKep.events]: [EV], [F.eventKep.penyelenggara]: ["recORGA0000000001"] } },
    { id: KEPB, fields: { [F.eventKep.statusPersetujuan]: "Diajukan", [F.eventKep.events]: [EVB], [F.eventKep.penyelenggara]: ["recORGB0000000001"] } },
  ];
  store[T.akunKep] = [
    acc("recACCPICA0000001", "pic.a@x.id", "PIC Paroki", PA),
    acc("recACCPICA0000002", "old.pic.a@x.id", "PIC Paroki", PA, false),
    acc("recACCADMA0000001", "adm.a@x.id", "Admin Paroki", PA),
    acc("recACCPICB0000001", "pic.b@x.id", "PIC Paroki", PB),
  ];
  store[T.auditKep] = [
    { id: "recAUD00000000001", fields: { [F.auditKep.aksi]: "create_kep", [F.auditKep.pelaku]: "Submitter@X.id", [F.auditKep.targetId]: KEP } },
  ];
});

describe("logAudit", () => {
  it("writes one append-only row and throws when the write fails", async () => {
    await logAudit({ actorEmail: "a@x.id", action: "x", targetId: "t", before: { a: 1 }, after: "y" });
    const r = rows(T.auditKep).at(-1)!;
    expect(r.fields[F.auditKep.aksi]).toBe("x");
    expect(r.fields[F.auditKep.pelaku]).toBe("a@x.id");
    expect(r.fields[F.auditKep.sebelum]).toBe('{"a":1}');
    expect(r.fields[F.auditKep.sesudah]).toBe("y");
    vi.mocked(client.createRecords).mockRejectedValueOnce(new Error("x"));
    await expect(logAudit({ actorEmail: "a", action: "x", targetId: "t" })).rejects.toThrow();
  });
});

describe("decideKep", () => {
  it("PIC and ADMIN get 403 and nothing changes", async () => {
    for (const s of [picA, admA]) await expect(decideKep(s, KEP, "Disetujui", "")).rejects.toMatchObject({ status: 403 });
    expect(kepRow().fields[F.eventKep.statusPersetujuan]).toBe("Diajukan");
    expect(sent).toHaveLength(0);
  });
  it("Ditolak without (or with blank) catatan is a 422", async () => {
    for (const c of ["", "   ", undefined as never]) await expect(decideKep(sep, KEP, "Ditolak", c)).rejects.toMatchObject({ status: 422 });
    expect(kepRow().fields[F.eventKep.statusPersetujuan]).toBe("Diajukan");
    expect(rows(T.auditKep)).toHaveLength(1);
  });
  it("invalid decision / unknown KEP", async () => {
    await expect(decideKep(sep, KEP, "Mungkin" as never, "x")).rejects.toMatchObject({ status: 422 });
    await expect(decideKep(sep, "recNOPE000000000", "Disetujui", "")).rejects.toMatchObject({ status: 404 });
  });

  it("Disetujui: writes status + catatan via the SEP allowlist, one audit row, one email per distinct recipient", async () => {
    await decideKep(sep, KEP, "Disetujui", "Silakan lanjut");
    expect(kepRow().fields[F.eventKep.statusPersetujuan]).toBe("Disetujui");
    expect(kepRow().fields[F.eventKep.catatanSep]).toBe("Silakan lanjut");
    const upd = vi.mocked(client.updateRecords).mock.calls.find((c) => c[0] === T.eventKep)!;
    expect(upd[2]).toEqual(RESTRICTED[T.eventKep]);
    const audits = rows(T.auditKep).filter((a) => a.id !== "recAUD00000000001");
    expect(audits).toHaveLength(1);
    expect(audits[0].fields[F.auditKep.pelaku]).toBe("sepa@x.id");
    expect(audits[0].fields[F.auditKep.targetId]).toBe(KEP);
    expect(sent.map((m) => m.to).sort()).toEqual(["pic.a@x.id", "submitter@x.id"]);
    expect(sent.every((m) => m.template === "kep_keputusan")).toBe(true);
    expect(invalidateKepCache).toHaveBeenCalled();
  });

  it("emails only active PIC of the KEP's paroki plus the submitter (not Admin, inactive, other paroki)", async () => {
    await decideKep(sep, KEP, "Disetujui", "");
    const to = sent.map((m) => m.to).sort();
    expect(to).toEqual(["pic.a@x.id", "submitter@x.id"]);
    expect(to).not.toContain("pic.b@x.id");
  });
  it("sends exactly one email when the submitter is also the PIC", async () => {
    store[T.auditKep][0].fields[F.auditKep.pelaku] = "pic.a@x.id";
    await decideKep(sep, KEP, "Disetujui", "");
    expect(sent.map((m) => m.to)).toEqual(["pic.a@x.id"]);
  });

  it("audit failure aborts: no state change, no email", async () => {
    vi.mocked(client.createRecords).mockRejectedValueOnce(new Error("Airtable request failed: HTTP 500"));
    await expect(decideKep(sep, KEP, "Disetujui", "")).rejects.toThrow();
    expect(kepRow().fields[F.eventKep.statusPersetujuan]).toBe("Diajukan");
    expect(sent).toHaveLength(0);
  });
  it("a mail failure does not undo or fail the decision", async () => {
    setMailer({ send: async () => { throw new Error("smtp down"); } });
    await expect(decideKep(sep, KEP, "Disetujui", "")).resolves.toEqual({ emailTerkirim: false });
    expect(kepRow().fields[F.eventKep.statusPersetujuan]).toBe("Disetujui");
    expect(rows(T.auditKep).some((a) => a.fields[F.auditKep.aksi] === "decision_email_failed" && a.fields[F.auditKep.targetId] === KEP)).toBe(true);
  });
  it("reports emailTerkirim:true when all mails went out", async () => {
    await expect(decideKep(sep, KEP, "Disetujui", "")).resolves.toEqual({ emailTerkirim: true });
    expect(rows(T.auditKep).some((a) => a.fields[F.auditKep.aksi] === "decision_email_failed")).toBe(false);
  });
  it("uses the SubmittedBy field of the KEP as submitter", async () => {
    store[T.auditKep] = [];
    kepRow().fields[F.eventKep.submittedBy] = "Direct@X.id";
    await decideKep(sep, KEP, "Disetujui", "");
    expect(sent.map((m) => m.to).sort()).toEqual(["direct@x.id", "pic.a@x.id"]);
  });
  it("audit is written before the state change", async () => {
    const order: string[] = [];
    const c = vi.mocked(client.createRecords).getMockImplementation()!;
    const u = vi.mocked(client.updateRecords).getMockImplementation()!;
    vi.mocked(client.createRecords).mockImplementation(async (t, r, e) => (order.push("audit"), c(t, r, e)));
    vi.mocked(client.updateRecords).mockImplementation(async (t, r, e) => (order.push("update"), u(t, r, e)));
    await decideKep(sep, KEP, "Ditolak", "Tanggal bentrok");
    expect(order).toEqual(["audit", "update"]);
  });

  it("deciding twice is a 409 (same or opposite decision), nothing more is written or sent", async () => {
    await decideKep(sep, KEP, "Disetujui", "");
    sent.length = 0;
    const n = rows(T.auditKep).length;
    await expect(decideKep(sep, KEP, "Disetujui", "")).rejects.toMatchObject({ status: 409 });
    await expect(decideKep(sep, KEP, "Ditolak", "alasan")).rejects.toMatchObject({ status: 409 });
    expect(rows(T.auditKep)).toHaveLength(n);
    expect(sent).toHaveLength(0);
  });
  it("Ditolak -> Disetujui is allowed only with a catatan", async () => {
    await decideKep(sep, KEP, "Ditolak", "Tanggal bentrok");
    await expect(decideKep(sep, KEP, "Disetujui", "")).rejects.toMatchObject({ status: 422 });
    await decideKep(sep, KEP, "Disetujui", "Sudah diperbaiki");
    expect(kepRow().fields[F.eventKep.statusPersetujuan]).toBe("Disetujui");
    expect(kepRow().fields[F.eventKep.catatanSep]).toBe("Sudah diperbaiki");
  });
  it("a KEP without a status (legacy) cannot be decided", async () => {
    delete kepRow().fields[F.eventKep.statusPersetujuan];
    await expect(decideKep(sep, KEP, "Disetujui", "")).rejects.toMatchObject({ status: 409 });
  });
  it("HTML-escapes names and notes in the email", () => {
    const m = renderTemplate("kep_keputusan", { link: "https://kep.test/", kepNama: "<b>X</b>", keputusan: "Ditolak", catatan: '<script>alert("x")</script>', nama: "<i>n</i>" });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<b>X</b>");
    expect(m.html).not.toContain("<i>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.subject).toContain("Ditolak");
  });
  it("email carries the event name and the decision", async () => {
    await decideKep(sep, KEP, "Ditolak", "Tanggal bentrok");
    expect(sent[0].data).toMatchObject({ keputusan: "Ditolak", catatan: "Tanggal bentrok", kepNama: "KEP PAROKI PANDU <b>ANGKATAN</b> 9" });
  });
});

describe("listKepQueue", () => {
  it("SEP sees Diajukan/Ditolak KEPs; others 403", async () => {
    const q = await listKepQueue(sep);
    expect(q.map((x) => x.id).sort()).toEqual([KEP, KEPB].sort());
    expect(q.find((x) => x.id === KEP)).toMatchObject({ nama: "KEP PAROKI PANDU <b>ANGKATAN</b> 9", parokiNama: "Pandu", status: "Diajukan" });
    await decideKep(sep, KEP, "Disetujui", "");
    expect((await listKepQueue(sep)).map((x) => x.id)).toEqual([KEPB]);
    await expect(listKepQueue(picA)).rejects.toMatchObject({ status: 403 });
  });
});
