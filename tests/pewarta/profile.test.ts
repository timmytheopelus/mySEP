import { beforeEach, describe, expect, it, vi } from "vitest";
import { F, T, PENGAJAR_READ, ALLOWED } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({ logAudit: vi.fn(async () => {}) }));

import * as client from "@/lib/airtable/client";
import { invalidateKepCache } from "@/lib/kep/readModel";
import { logAudit } from "@/lib/audit/log";
import { filterPewarta, getPewarta, listPewarta, sanitizeBio, updatePewartaProfile, fotoSource } from "@/lib/pewarta/profile";
import type { Session } from "@/lib/auth/session";

const PA = "recPAROKIA0000001";
const PB = "recPAROKIB0000001";
const P1 = "recPEWARTA000001";
const P2 = "recPEWARTA000002";
const PX = "recPEWARTA000003"; // non aktif
const NOHP = "0812-3456-7890";
const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const picA: Session = { accountId: "recPICA000000001", email: "pica@x.id", role: "PIC", parokiId: PA };
const picB: Session = { accountId: "recPICB000000001", email: "picb@x.id", role: "PIC", parokiId: PB };
const admA: Session = { accountId: "recADMA000000001", email: "adma@x.id", role: "ADMIN", parokiId: PA };
const P = F.pengajarKep;
const row = (id: string) => store[T.pengajarKep].find((r) => r.id === id)!;

function seed(status = "Disetujui") {
  store[T.pengajarKep] = [
    { id: P1, fields: { [P.nama]: "Rm. Andi", [P.status]: "Aktif", [PENGAJAR_READ.noHp]: NOHP, [PENGAJAR_READ.bab]: ["recBAB1000000001"], [P.bioSingkat]: "Bio <b>tebal</b>", [P.linkYoutube]: "https://youtu.be/dQw4w9WgXcQ", [P.photo]: [{ url: "https://v5.airtableusercontent.com/x.jpg", thumbnails: { large: { url: "https://v5.airtableusercontent.com/t.jpg" } } }] } },
    { id: P2, fields: { [P.nama]: "Budi", [P.status]: "Aktif", [PENGAJAR_READ.noHp]: "0899", [PENGAJAR_READ.bab]: ["recBAB2000000001"] } },
    { id: PX, fields: { [P.nama]: "Cici", [P.status]: "Nonaktif", [PENGAJAR_READ.noHp]: "0877" } },
  ];
  store[T.babKep] = [
    { id: "recBAB1000000001", fields: { [F.babKep.bab]: "Bab 1 Orientasi Evangelisasi" } },
    { id: "recBAB2000000001", fields: { [F.babKep.bab]: "Bab 2 Evangelisasi Pendalaman" } },
  ];
  store[T.subEvent] = [{ id: "recSUB0000000001", fields: { [F.subEvent.acara]: ["recEVA00000000001"], [F.subEvent.pengajar]: [P1] } }];
  store[T.penyelenggaraKep] = [
    { id: "recORGA0000000001", fields: { [F.penyelenggaraKep.paroki]: [PA] } },
    { id: "recORGB0000000001", fields: { [F.penyelenggaraKep.paroki]: [PB] } },
  ];
  store[T.eventKep] = [
    { id: "recKEPA0000000001", fields: { [F.eventKep.statusPersetujuan]: status, [F.eventKep.events]: ["recEVA00000000001"], [F.eventKep.penyelenggara]: ["recORGA0000000001"] } },
  ];
}
beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seed();
});

describe("listPewarta", () => {
  it("lists only Aktif and never reads or returns NoHP", async () => {
    const out = await listPewarta(sep);
    expect(out.map((c) => c.id).sort()).toEqual([P1, P2]);
    expect(JSON.stringify(out)).not.toContain("0812");
    expect(JSON.stringify(out)).not.toContain("0899");
    for (const c of vi.mocked(client.listRecords).mock.calls) expect((c[1] as { fields: string[] }).fields).not.toContain(PENGAJAR_READ.noHp);
    expect(out.find((c) => c.id === P1)!.babs).toEqual(["Bab 1 Orientasi Evangelisasi"]);
  });
  it("filters by bab and nama", async () => {
    const all = await listPewarta(picA);
    expect(filterPewarta(all, { bab: "Bab 2 Evangelisasi Pendalaman" }).map((c) => c.id)).toEqual([P2]);
    expect(filterPewarta(all, { nama: "andi" }).map((c) => c.id)).toEqual([P1]);
    expect((await listPewarta(picA, { nama: "bud" })).map((c) => c.id)).toEqual([P2]);
  });
});

describe("getPewarta noHp rule", () => {
  it("SEP gets it", async () => expect((await getPewarta(sep, P1)).noHp).toBe(NOHP));
  it("PIC of the paroki gets it only once the KEP is Disetujui", async () => {
    expect((await getPewarta(picA, P1)).noHp).toBe(NOHP);
    for (const s of ["Diajukan", "Ditolak", ""]) {
      resetStore();
      seed(s);
      expect((await getPewarta(picA, P1)).noHp).toBeUndefined();
    }
  });
  it("PIC of another paroki, unassigned pewarta, and Admin never get it", async () => {
    expect((await getPewarta(picB, P1)).noHp).toBeUndefined();
    expect((await getPewarta(picA, P2)).noHp).toBeUndefined();
    const a = await getPewarta(admA, P1);
    expect(a.noHp).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain("0812");
  });
  it("fails closed when a shared event also belongs to a foreign KEP", async () => {
    store[T.eventKep].push({ id: "recKEPB0000000001", fields: { [F.eventKep.statusPersetujuan]: "Disetujui", [F.eventKep.events]: ["recEVA00000000001"], [F.eventKep.penyelenggara]: ["recORGB0000000001"] } });
    expect((await getPewarta(picA, P1)).noHp).toBeUndefined();
  });
  it("NoHP is fetched in a separate read only when authorized", async () => {
    await getPewarta(admA, P1);
    const withPhone = vi.mocked(client.listRecords).mock.calls.filter((c) => (c[1] as { fields: string[] }).fields.includes(PENGAJAR_READ.noHp));
    expect(withPhone).toHaveLength(0);
  });
  it("404 for inactive, unknown and malformed ids", async () => {
    for (const id of [PX, "recNOPE000000000", "x'); DROP"]) await expect(getPewarta(sep, id)).rejects.toMatchObject({ status: 404 });
  });
  it("returns plain-text bio and a safe embed id", async () => {
    const d = await getPewarta(sep, P1);
    expect(d.bio).toBe("Bio tebal");
    expect(d.youtubeId).toBe("dQw4w9WgXcQ");
    expect(d.adaFoto).toBe(true);
  });
  it("hides a stored non-YouTube link", async () => {
    row(P1).fields[P.linkYoutube] = "https://evil.com/watch?v=dQw4w9WgXcQ";
    expect((await getPewarta(sep, P1)).youtubeId).toBeNull();
  });
});

describe("sanitizeBio", () => {
  it("strips html and caps length", () => {
    expect(sanitizeBio("<script>alert(1)</script>Halo <img src=x onerror=1> dunia")).toBe("alert(1)Halo dunia");
    expect(sanitizeBio("a<b")).not.toContain("<");
    expect(sanitizeBio("x".repeat(5000))).toHaveLength(1000);
    expect(sanitizeBio("&lt;b&gt;")).not.toContain("<");
  });
});

describe("updatePewartaProfile", () => {
  it("PIC and Admin get 403, nothing written", async () => {
    for (const s of [picA, admA]) await expect(updatePewartaProfile(s, P1, { bioSingkat: "x" })).rejects.toMatchObject({ status: 403 });
    expect(client.updateRecords).not.toHaveBeenCalled();
  });
  it("SEP: sanitizes bio, canonicalizes link, audits before write, invalidates", async () => {
    await updatePewartaProfile(sep, P1, { bioSingkat: "<b>Baru</b>", linkYoutube: "https://youtu.be/AAAAAAAAAAA" });
    expect(row(P1).fields[P.bioSingkat]).toBe("Baru");
    expect(row(P1).fields[P.linkYoutube]).toBe("https://www.youtube.com/watch?v=AAAAAAAAAAA");
    expect(vi.mocked(logAudit).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(client.updateRecords).mock.invocationCallOrder[0]);
    expect(invalidateKepCache).toHaveBeenCalled();
  });
  it("aborts without writing when audit fails", async () => {
    vi.mocked(logAudit).mockRejectedValueOnce(new Error("down"));
    await expect(updatePewartaProfile(sep, P1, { bioSingkat: "x" })).rejects.toThrow();
    expect(client.updateRecords).not.toHaveBeenCalled();
  });
  it("rejects bad links, unknown keys, empty input, bad ids", async () => {
    for (const bad of ["https://evil.com/?v=dQw4w9WgXcQ", "javascript:alert(1)"])
      await expect(updatePewartaProfile(sep, P1, { linkYoutube: bad })).rejects.toMatchObject({ status: 422 });
    await expect(updatePewartaProfile(sep, P1, { noHp: "1" } as never)).rejects.toMatchObject({ status: 422 });
    await expect(updatePewartaProfile(sep, P1, {})).rejects.toMatchObject({ status: 422 });
    await expect(updatePewartaProfile(sep, "bad", { bioSingkat: "x" })).rejects.toMatchObject({ status: 404 });
    expect(client.updateRecords).not.toHaveBeenCalled();
  });
  it("empty link clears it", async () => {
    await updatePewartaProfile(sep, P1, { linkYoutube: "" });
    expect(row(P1).fields[P.linkYoutube]).toBeUndefined();
  });
});

describe("schema safety", () => {
  it("NoHP, status, name, links and photo are never writable", () => {
    const w = ALLOWED[T.pengajarKep];
    for (const f of [PENGAJAR_READ.noHp, PENGAJAR_READ.bab, PENGAJAR_READ.subEvent, P.status, P.nama, P.photo]) expect(w.has(f)).toBe(false);
    expect([...w].sort()).toEqual([P.bioSingkat, P.linkYoutube].sort());
  });
});

describe("fotoSource", () => {
  it("returns the Airtable thumbnail url for an active pewarta", async () => {
    expect(await fotoSource(sep, P1)).toBe("https://v5.airtableusercontent.com/t.jpg");
  });
  it("404 when no photo, inactive or foreign host", async () => {
    await expect(fotoSource(sep, P2)).rejects.toMatchObject({ status: 404 });
    await expect(fotoSource(sep, PX)).rejects.toMatchObject({ status: 404 });
    row(P1).fields[P.photo] = [{ url: "https://evil.com/a.jpg", thumbnails: { large: { url: "https://airtableusercontent.com.evil.io/a.jpg" } } }];
    await expect(fotoSource(sep, P1)).rejects.toMatchObject({ status: 404 });
    row(P1).fields[P.photo] = [{ url: "http://v5.airtableusercontent.com/a.jpg" }];
    await expect(fotoSource(sep, P1)).rejects.toMatchObject({ status: 404 });
  });
});
