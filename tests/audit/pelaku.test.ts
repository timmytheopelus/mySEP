import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/email", () => ({ sendMail: vi.fn(async () => undefined), mailConfigured: () => false, appBaseUrl: () => "https://kep.test", setMailer: () => undefined }));

import { auditRecordFields } from "@/lib/accounts/repo";
import { logAudit } from "@/lib/audit/log";
import { registerPeserta } from "@/lib/kep/registration";
import { resetRateLimitMemory } from "@/lib/ratelimit";

const AU = F.auditKep;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PA = "recPAROKIA0000001";
const EV = "recEVA00000000001";

/** Final fix I5: AuditKEP.Pelaku is an Airtable email field. */
describe("AuditKEP.Pelaku is a valid email or absent", () => {
  beforeEach(() => {
    resetStore();
    resetRateLimitMemory();
  });

  it("auditRecordFields: an email is kept; 'publik' / junk is never written to Pelaku and goes to Sesudah.actorType", () => {
    expect(auditRecordFields({ aksi: "a", pelaku: "pic@x.id", targetId: "t" })[AU.pelaku]).toBe("pic@x.id");
    const pub = auditRecordFields({ aksi: "a", pelaku: "publik", targetId: "t", sesudah: JSON.stringify({ k: 1 }) });
    expect(pub).not.toHaveProperty(AU.pelaku);
    expect(JSON.parse(String(pub[AU.sesudah]))).toEqual({ k: 1, actorType: "publik" });
    const typed = auditRecordFields({ aksi: "a", actorType: "publik", targetId: "t" });
    expect(typed).not.toHaveProperty(AU.pelaku);
    expect(JSON.parse(String(typed[AU.sesudah]))).toEqual({ actorType: "publik" });
    const text = auditRecordFields({ aksi: "a", pelaku: "<script>@", targetId: "t", sesudah: "teks bebas" });
    expect(text).not.toHaveProperty(AU.pelaku);
    expect(JSON.parse(String(text[AU.sesudah]))).toEqual({ actorType: "script", nilai: "teks bebas" });
    expect(auditRecordFields({ aksi: "a", targetId: "t" })).not.toHaveProperty(AU.pelaku);
  });

  it("logAudit through the client: every written row has an email Pelaku or none", async () => {
    await logAudit({ actorEmail: "sep@x.id", action: "a", targetId: "t" });
    await logAudit({ actorType: "publik", action: "b", targetId: "t" });
    await logAudit({ actorEmail: "publik", action: "c", targetId: "t" }); // defensive: never reaches Pelaku
    for (const r of store[T.auditKep]) {
      const v = r.fields[AU.pelaku];
      expect(v === undefined || (typeof v === "string" && EMAIL.test(v))).toBe(true);
    }
    expect(store[T.auditKep]).toHaveLength(3);
  });

  it("public registration with health data succeeds; its consent audit carries actorType 'publik' and no Pelaku", async () => {
    store[T.paroki] = [{ id: PA, fields: { [F.paroki.nama]: "Paroki A" } }];
    store[T.eventKep] = [{ id: "recKEPA0000000001", fields: { [F.eventKep.events]: [EV], [F.eventKep.statusPersetujuan]: "Disetujui" } }];
    store[T.events] = [{ id: EV, fields: { [F.events.namaAcara]: "KEP PAROKI A ANGKATAN 1" } }];
    store[T.teamUmat] = [];
    store[T.pendaftaranEvents] = [];
    store[T.auditKep] = [];
    const r = await registerPeserta(EV, {
      namaLengkap: "Maria Goreti",
      jenisKelamin: "Wanita",
      tanggalLahir: "1985-04-12",
      wa: "0812-3456-789",
      email: "maria@example.com",
      alamat: "Jl. Merdeka 1, Bandung",
      parokiAsalId: PA,
      statusPernikahan: "Menikah",
      kontakDarurat: "Yohanes 081111111111",
      pendukungDoa: [
        { nama: "Ana", kontak: "081200000001" },
        { nama: "Budi", kontak: "081200000002" },
      ],
      persetujuanKesehatan: true,
      riwayatPenyakit: "x",
    });
    expect(r.status).toBe("registered");
    const consent = store[T.auditKep].find((x) => x.fields[AU.aksi] === "persetujuan_data_kesehatan")!;
    expect(consent.fields).not.toHaveProperty(AU.pelaku);
    expect(JSON.parse(String(consent.fields[AU.sesudah])).actorType).toBe("publik");
  });

  it("no call site passes a non-email literal as actor (src/ and scripts/)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n)) files.push(p);
      }
    };
    walk("src");
    walk("scripts");
    const bad: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/(actorEmail|pelaku)\s*:\s*(?:[^,}\n]*\?\?\s*)?["'`]([^"'`]*)["'`]/g)) if (!EMAIL.test(m[2]) && !/^fld[A-Za-z0-9]{14}$/.test(m[2])) bad.push(`${f}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
