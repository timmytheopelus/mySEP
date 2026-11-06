import { describe, it, expect } from "vitest";
import { T, F, ALLOWED, pickAllowed } from "@/lib/airtable/schema";

describe("schema", () => {
  it("pickAllowed drops fields outside the allowlist", () => {
    const out = pickAllowed(T.teamUmat, {
      fldNotInAllowlist000: "x",
      [F.teamUmat.namaLengkap]: "A",
    });
    expect(out).toEqual({ [F.teamUmat.namaLengkap]: "A" });
  });

  it("fails closed (throws) for tables without an allowlist", () => {
    expect(() => pickAllowed("tblUnknown", { [F.teamUmat.namaLengkap]: "A" })).toThrow();
  });

  it("allowlists every known field and no reverse-link fields", () => {
    expect(ALLOWED[T.subEvent].has(F.subEvent.agenda)).toBe(true);
    expect(ALLOWED[T.akunKep].has(F.akunKep.hashPassword)).toBe(true);
    expect(F.akunKep.langkahTotpTerakhir).toBe("fldxXkIOldyt3Fd7E");
    expect(ALLOWED[T.akunKep].has(F.akunKep.langkahTotpTerakhir)).toBe(true);
    expect(ALLOWED[T.events].has("fldvytyB1Pyrt0qKB")).toBe(false);
  });
});
