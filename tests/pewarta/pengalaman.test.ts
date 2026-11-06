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

beforeEach(() => {
  resetStore();
  store[T.eventKep] = [{ id: "recKEP1", fields: { [F.eventKep.events]: ["recEV1"] } }];
  const sub = (id: string, acara: string, pengajar?: string[]) => ({ id, fields: { [F.subEvent.acara]: [acara], ...(pengajar ? { [F.subEvent.pengajar]: pengajar } : {}) } });
  store[T.subEvent] = [
    sub("recS1", "recEV1", ["recP1", "recP2"]),
    sub("recS2", "recEV1", ["recP1"]),
    sub("recS3", "recEV1", ["recP1", "recP1"]),
    sub("recS4", "recEV1"),
    sub("recS5", "recEVNONKEP", ["recP1", "recP3"]), // a non-KEP BPK event does not count
  ];
});

describe("pengalamanPewarta", () => {
  it("counts the KEP pertemuan each pewarta teaches (one per pertemuan, non-KEP events ignored), aggregates only", async () => {
    const m = await pengalamanPewarta(sep);
    expect(m.get("recP1")).toBe(3);
    expect(m.get("recP2")).toBe(1);
    expect(m.get("recP3")).toBeUndefined();
    expect([...m.values()].every((v) => typeof v === "number")).toBe(true);
  });
  it("is available to PIC, refused for a PIC without paroki", async () => {
    expect((await pengalamanPewarta(pic)).get("recP1")).toBe(3);
    await expect(pengalamanPewarta(noParoki)).rejects.toMatchObject({ status: 403 });
  });
});
