import { beforeEach, describe, expect, it, vi } from "vitest";
import { F, T } from "@/lib/airtable/schema";
import { fakeClientModule, resetStore, store } from "../helpers/fake-airtable";

vi.mock("@/lib/airtable/client", () => fakeClientModule());
vi.mock("@/lib/kep/readModel", () => ({ invalidateKepCache: vi.fn() }));

import { pengalamanPewarta } from "@/lib/pewarta/pengalaman";
import type { Session } from "@/lib/auth/session";

const sep: Session = { accountId: "recSEPA000000001", email: "sepa@x.id", role: "SEP", parokiId: null };
const pic: Session = { accountId: "recPIC0000000001", email: "pic@x.id", role: "PIC", parokiId: "recPAROKIA0000001" };
const noParoki: Session = { accountId: "recPIC0000000002", email: "p2@x.id", role: "PIC", parokiId: null };

const wib = (d: number) => new Date(Date.now() + 7 * 3600_000 + d * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  resetStore();
  store[T.eventKep] = [
    { id: "recKEP1", fields: { [F.eventKep.events]: ["recEV1"], [F.eventKep.statusPersetujuan]: "Disetujui" } },
    { id: "recKEP2", fields: { [F.eventKep.events]: ["recEV2"], [F.eventKep.statusPersetujuan]: "Diajukan" } },
  ];
  const sub = (id: string, acara: string, tanggal: string, pengajar?: string[]) => ({
    id,
    fields: { [F.subEvent.acara]: [acara], [F.subEvent.tanggal]: tanggal, ...(pengajar ? { [F.subEvent.pengajar]: pengajar } : {}) },
  });
  store[T.subEvent] = [
    sub("recS1", "recEV1", wib(-14), ["recP1", "recP2"]),
    sub("recS2", "recEV1", wib(-7), ["recP1"]),
    sub("recS3", "recEV1", wib(0), ["recP1", "recP1"]), // today counts
    sub("recS4", "recEV1", wib(-3)),
    sub("recS5", "recEVNONKEP", wib(-3), ["recP1", "recP3"]), // not a KEP event
    sub("recS6", "recEV1", wib(7), ["recP1", "recP4"]), // future: not taught yet
    sub("recS7", "recEV2", wib(-3), ["recP1", "recP5"]), // KEP not approved: assignment is only a proposal
  ];
});

describe("pengalamanPewarta", () => {
  it("counts pertemuan already held (date <= today WIB) of Disetujui KEPs only, one per pertemuan, aggregates only", async () => {
    const m = await pengalamanPewarta(sep);
    expect(m.get("recP1")).toBe(3);
    expect(m.get("recP2")).toBe(1);
    for (const none of ["recP3", "recP4", "recP5"]) expect(m.get(none)).toBeUndefined();
    expect([...m.values()].every((v) => typeof v === "number")).toBe(true);
  });
  it("is available to PIC, refused for a PIC without paroki", async () => {
    expect((await pengalamanPewarta(pic)).get("recP1")).toBe(3);
    await expect(pengalamanPewarta(noParoki)).rejects.toMatchObject({ status: 403 });
  });
});
