import { describe, expect, it } from "vitest";
import { KEP_TEMPLATE, scheduleDates } from "@/lib/kep/template";

describe("KEP_TEMPLATE", () => {
  it("has exactly 28 entries with consecutive urutan from 1", () => {
    expect(KEP_TEMPLATE).toHaveLength(28);
    expect(KEP_TEMPLATE.map((e) => e.urutan)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
  });
  it("starts with Misa Pembukaan and ends with the two Retreat Pengutusan days", () => {
    expect(KEP_TEMPLATE[0].agenda).toBe("Misa Pembukaan");
    expect(KEP_TEMPLATE[26].agenda).toBe("Retreat Pengutusan hari 1");
    expect(KEP_TEMPLATE[27].agenda).toBe("Retreat Pengutusan hari 2");
  });
  it("follows the listed order and counts", () => {
    const names = KEP_TEMPLATE.map((e) => e.agenda);
    const count = (n: string) => names.filter((x) => x === n).length;
    expect(names.slice(0, 6)).toEqual(["Misa Pembukaan", "Bab 1", "Bab 2", "Bab 2", "Evangelii Nuntiandi", "Evangelii Nuntiandi"]);
    for (let b = 3; b <= 9; b++) expect(count(`Bab ${b}`)).toBe(2);
    expect(count("Bab 10")).toBe(2);
    expect(names.slice(22)).toEqual([
      "Maria Bintang Evangelisasi",
      "Iman Katolik",
      "Bab 10 (praktik)",
      "Evaluasi Kunjungan rumah",
      "Retreat Pengutusan hari 1",
      "Retreat Pengutusan hari 2",
    ]);
  });
});

describe("scheduleDates", () => {
  it("is weekly, one date per template entry, last two consecutive", () => {
    const d = scheduleDates("2027-01-01");
    expect(d).toHaveLength(28);
    expect(d[0]).toBe("2027-01-01");
    expect(d[1]).toBe("2027-01-08");
    for (let i = 1; i <= 26; i++) expect(Date.parse(d[i]) - Date.parse(d[i - 1])).toBe(7 * 86400000);
    // retreat day 1 = last regular meeting (Evaluasi, index 25) + 7 days, day 2 = +1 day
    expect(Date.parse(d[26]) - Date.parse(d[25])).toBe(7 * 86400000);
    expect(Date.parse(d[27]) - Date.parse(d[26])).toBe(86400000);
  });
  it("crosses month and year boundaries without drift (UTC date math, Asia/Jakarta safe)", () => {
    const prev = process.env.TZ;
    try {
      for (const tz of ["Asia/Jakarta", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        const d = scheduleDates("2027-12-25");
        expect(d.slice(0, 4)).toEqual(["2027-12-25", "2028-01-01", "2028-01-08", "2028-01-15"]);
        expect(d[27]).toBe(scheduleDates("2027-12-25")[27]);
        expect(scheduleDates("2028-02-26").slice(0, 3)).toEqual(["2028-02-26", "2028-03-04", "2028-03-11"]); // leap year
      }
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
  it("rejects invalid dates", () => {
    for (const bad of ["2027-02-30", "2027-1-1", "", "2027-01-01T00:00:00Z", "abc"]) expect(() => scheduleDates(bad)).toThrow();
  });
});
