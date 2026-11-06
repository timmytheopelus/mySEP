import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { F, T } from "@/lib/airtable/schema";
import { applyPlan, buildPlan, main, type DataSource } from "../../scripts/map-legacy";

type Row = { id: string; fields: Record<string, unknown> };
const FIX = join(__dirname, "fixtures");
const load = (n: string): Row[] => JSON.parse(readFileSync(join(FIX, `${n}.json`), "utf8"));
const TABLE_FILE: Record<string, string> = {
  [T.babKep]: "babkep",
  [T.eventKep]: "eventkep",
  [T.penyelenggaraKep]: "pengelenggara",
  [T.paroki]: "paroki",
  [T.events]: "events",
  [T.subEvent]: "subevent",
};

let store: Record<string, Row[]>;
let created: { table: string; rows: Record<string, unknown>[] }[];
let updated: { table: string; rows: Row[]; extra?: Set<string> }[];
let reads: string[];

function memorySource(kind: "live" | "snapshot" = "live"): DataSource {
  return {
    kind,
    read: vi.fn(async (t: string) => {
      reads.push(t);
      return structuredClone(store[t] ?? []);
    }),
    create: vi.fn(async (t: string, rows: Record<string, unknown>[]) => {
      created.push({ table: t, rows: structuredClone(rows) });
      const out = rows.map((fields, i) => ({ id: `recNEW${t.slice(-4)}${(store[t] ?? []).length + i}`, fields: structuredClone(fields) }));
      (store[t] ??= []).push(...out);
      return out;
    }),
    update: vi.fn(async (t: string, rows: Row[], extra?: Set<string>) => {
      updated.push({ table: t, rows: structuredClone(rows), extra });
      for (const r of rows) Object.assign((store[t] ?? []).find((x) => x.id === r.id)!.fields, r.fields);
      return rows;
    }),
  };
}

let out: string;
const EMAIL = "operator@example.org";
let logs: string[];
const run = (argv: string[], source?: DataSource, env: Record<string, string | undefined> = { MAP_LEGACY_ACTOR_EMAIL: EMAIL }) =>
  main(argv, { source, outDir: out, sleep: async () => {}, log: (s) => logs.push(s), env });
const hashOf = async (src: DataSource) => {
  logs = [];
  await run([], src);
  return /Plan hash: ([0-9a-f]{64})/.exec(logs.join("\n"))![1];
};
/** Approved apply: dry-run for the hash first, then apply with exactly that hash. */
const apply = async (src: DataSource, extra: string[] = []) => run(["--apply", "--confirm=YA", `--expect-hash=${await hashOf(src)}`, ...extra], src);
const csv = () => readFileSync(join(out, "legacy-mapping.csv"), "utf8").replace(/^\ufeff/, "");
const lines = () => csv().split("\r\n").filter(Boolean);
const withJenis = (j: string) => lines().filter((l) => l.startsWith(j + ","));

beforeEach(() => {
  store = {};
  for (const [t, f] of Object.entries(TABLE_FILE)) store[t] = load(f);
  logs = [];
  created = [];
  updated = [];
  reads = [];
  out = mkdtempSync(join(tmpdir(), "map-legacy-"));
});

describe("map-legacy dry-run", () => {
  it("never calls create/update and writes the CSV with the required columns", async () => {
    const src = memorySource();
    expect(await run([], src)).toBe(0);
    expect(src.create).not.toHaveBeenCalled();
    expect(src.update).not.toHaveBeenCalled();
    expect(lines()[0]).toBe("jenis,tabel,record id(s),keterangan,rencana");
    expect(withJenis("rencana tulis").length).toBeGreaterThan(0);
    expect(withJenis("cocok").length).toBeGreaterThan(0);
  });

  it("works from a snapshot directory and reads nothing live", async () => {
    expect(await main(["--from-snapshot", FIX], { outDir: out, log: () => {} })).toBe(0);
    expect(existsSync(join(out, "legacy-mapping.csv"))).toBe(true);
    expect(withJenis("rencana tulis").length).toBeGreaterThan(0);
  });

  it("reports duplicates (Laurentius angkatan 18 x2) and does not merge or write them", async () => {
    const src = memorySource();
    await run(["--dry-run"], src);
    const dup = withJenis("duplikat").join("\n");
    expect(dup).toContain("recEV_L18a");
    expect(dup).toContain("recEV_L18b");
    await apply(src, ["--rerun"]);
    expect(store[T.events]).toHaveLength(5); // nothing merged or deleted
    expect(store[T.eventKep].find((r) => r.id === "recKEP_L18")!.fields[F.eventKep.events]).toBeUndefined(); // ambiguous Events match not written
  });

  it("marks unknown parish as 'tidak cocok' and never writes it", async () => {
    const src = memorySource();
    await run([], src);
    expect(withJenis("tidak cocok").join("\n")).toContain("recORG_UNK");
    await apply(src, ["--rerun"]);
    expect(store[T.penyelenggaraKep].find((r) => r.id === "recORG_UNK")!.fields[F.penyelenggaraKep.paroki]).toBeUndefined();
    expect(store[T.subEvent].some((r) => String(r.fields[F.subEvent.keterangan]).includes("recBAB5"))).toBe(false);
  });

  it("neutralizes spreadsheet formulas in the CSV", async () => {
    store[T.penyelenggaraKep].push({ id: "recORG_EVIL", fields: { [F.penyelenggaraKep.penyelenggara]: "=HYPERLINK(\"http://x\")" } });
    await run([], memorySource());
    expect(csv()).toContain("'=HYPERLINK");
    expect(csv()).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});

describe("map-legacy apply", () => {
  it("without --confirm=YA exits non-zero and touches nothing", async () => {
    for (const argv of [["--apply"], ["--apply", "--confirm=ya"], ["--apply", "--confirm"], ["--apply", "--confirm=NO"]]) {
      const src = memorySource();
      expect(await run(argv, src)).not.toBe(0);
      expect(src.read).not.toHaveBeenCalled();
      expect(src.create).not.toHaveBeenCalled();
      expect(src.update).not.toHaveBeenCalled();
    }
  });

  it("is refused from a snapshot", async () => {
    expect(await main(["--from-snapshot", FIX, "--apply", "--confirm=YA"], { outDir: out, log: () => {} })).not.toBe(0);
    expect(await run(["--apply", "--confirm=YA"], memorySource("snapshot"))).not.toBe(0);
  });

  it("copies BabKEP to SubEvent, fills Events and Paroki, and is idempotent on a second apply", async () => {
    const src = memorySource();
    expect(await apply(src)).toBe(0);
    const subs = store[T.subEvent].filter((r) => String(r.fields[F.subEvent.keterangan]).startsWith("legacy:"));
    // recBAB7 was already copied; BAB1-4 are new (BAB4/BAB3 -> KR3, BAB1/BAB2 -> G5); BAB5/BAB6 unmapped
    expect(subs.map((r) => r.fields[F.subEvent.keterangan]).sort()).toEqual(["legacy:recBAB1", "legacy:recBAB2", "legacy:recBAB3", "legacy:recBAB4", "legacy:recBAB7"]);
    const g5 = subs.filter((r) => (r.fields[F.subEvent.acara] as string[])[0] === "recEV_G5");
    const bab2 = g5.find((r) => r.fields[F.subEvent.keterangan] === "legacy:recBAB2")!;
    const bab1 = g5.find((r) => r.fields[F.subEvent.keterangan] === "legacy:recBAB1")!;
    expect(bab2.fields[F.subEvent.agenda]).toBe("Peneguhan");
    expect(bab2.fields[F.subEvent.tanggal]).toBe("2024-02-24");
    expect(bab2.fields[F.subEvent.urutan]).toBe(1); // earlier date first
    expect(bab1.fields[F.subEvent.urutan]).toBe(2);
    expect(bab1.fields[F.subEvent.pengajar]).toEqual(["recPJ1"]);
    const kr = subs.filter((r) => (r.fields[F.subEvent.acara] as string[])[0] === "recEV_KR3" && r.id !== "recSUB_OLD");
    expect(kr.map((r) => r.fields[F.subEvent.urutan]).sort()).toEqual([2, 3]); // after the existing urutan 1
    expect(store[T.eventKep].find((r) => r.id === "recKEP_G5")!.fields[F.eventKep.events]).toEqual(["recEV_G5"]);
    expect(store[T.penyelenggaraKep].find((r) => r.id === "recORG_LAUR")!.fields[F.penyelenggaraKep.paroki]).toEqual(["recPAR_LAUR"]);
    expect(store[T.penyelenggaraKep].find((r) => r.id === "recORG_GAN")!.fields[F.penyelenggaraKep.paroki]).toEqual(["recPAR_GAN"]);
    // the audit row carries counts only
    const audit = created.filter((c) => c.table === T.auditKep);
    expect(audit).toHaveLength(1);
    expect(audit[0].rows[0][F.auditKep.aksi]).toBe("legacy_map_apply");
    expect(audit[0].rows[0][F.auditKep.pelaku]).toBe(EMAIL);
    expect(audit[0].rows[0][F.auditKep.targetId]).toBe("map-legacy");
    const sesudah = JSON.parse(String(audit[0].rows[0][F.auditKep.sesudah]));
    expect(Object.values(sesudah).every((v) => typeof v === "number" || typeof v === "boolean")).toBe(true);
    expect(logs.join("\n")).toMatch(/Applied: SubEvent dibuat=4/);

    const before = { created: created.length, updated: updated.length, subs: store[T.subEvent].length };
    expect(await apply(src, ["--rerun"])).toBe(0);
    expect(store[T.subEvent]).toHaveLength(before.subs);
    expect(created.slice(before.created).filter((c) => c.table === T.subEvent)).toHaveLength(0);
    expect(updated).toHaveLength(before.updated);
  });

  it("never writes a non-empty field and never deletes", async () => {
    const src = memorySource();
    await apply(src, ["--rerun"]);
    const touched = updated.flatMap((u) => u.rows.map((r) => r.id));
    expect(touched).not.toContain("recKEP_KR3"); // Events already set
    expect(touched).not.toContain("recORG_KR"); // Paroki already set (even to a different parish)
    expect(store[T.penyelenggaraKep].find((r) => r.id === "recORG_KR")!.fields[F.penyelenggaraKep.paroki]).toEqual(["recPAR_GAN"]);
    expect(store[T.eventKep].find((r) => r.id === "recKEP_KR3")!.fields[F.eventKep.events]).toEqual(["recEV_KR3"]);
    for (const u of updated)
      for (const r of u.rows) {
        const keys = Object.keys(r.fields);
        expect(keys).toHaveLength(1);
        expect([F.eventKep.events, F.penyelenggaraKep.paroki]).toContain(keys[0]);
      }
    expect(updated.every((u) => u.table === T.eventKep || u.table === T.penyelenggaraKep)).toBe(true);
    expect(created.every((c) => c.table === T.subEvent || c.table === T.auditKep)).toBe(true);
  });

  it("writes in batches of at most 10", async () => {
    store[T.eventKep].push({ id: "recKEP_BIG", fields: { [F.eventKep.events]: ["recEV_G5"], [F.eventKep.angkatan]: 5 } });
    for (let i = 0; i < 25; i++)
      store[T.babKep].push({ id: `recBIG${i}`, fields: { [F.babKep.bab]: "Bab 3 Perkembangan Iman", [F.babKep.eventKep]: ["recKEP_BIG"] } });
    const src = memorySource();
    await apply(src, ["--rerun"]);
    const subCalls = created.filter((c) => c.table === T.subEvent);
    expect(subCalls.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...subCalls.map((c) => c.rows.length))).toBeLessThanOrEqual(10);
  });

  it("refuses without a valid actor email, without --expect-hash, with a stale hash, and on a second run without --rerun", async () => {
    const src = memorySource();
    const h = await hashOf(src);
    for (const [argv, env] of [
      [["--apply", "--confirm=YA", `--expect-hash=${h}`], {}],
      [["--apply", "--confirm=YA", `--expect-hash=${h}`], { MAP_LEGACY_ACTOR_EMAIL: "script:map-legacy" }],
      [["--apply", "--confirm=YA"], { MAP_LEGACY_ACTOR_EMAIL: EMAIL }],
      [["--apply", "--confirm=YA", `--expect-hash=${"0".repeat(64)}`], { MAP_LEGACY_ACTOR_EMAIL: EMAIL }],
    ] as [string[], Record<string, string>][]) {
      expect(await run(argv, src, env)).toBe(2);
    }
    expect(src.create).not.toHaveBeenCalled();
    expect(src.update).not.toHaveBeenCalled();
    expect(await apply(src)).toBe(0);
    expect(await run(["--apply", "--confirm=YA", `--expect-hash=${await hashOf(src)}`], src)).toBe(2);
  });

  it("partial failure: audit says failed, exit 1, re-run creates no duplicate keys and keeps Urutan contiguous", async () => {
    for (let i = 0; i < 25; i++)
      store[T.babKep].push({ id: `recPF${String(i).padStart(2, "0")}`, fields: { [F.babKep.bab]: "Bab 3 Perkembangan Iman", [F.babKep.tanggal]: `2024-06-${String(i + 1).padStart(2, "0")}`, [F.babKep.eventKep]: ["recKEP_G5"] } });
    const src = memorySource();
    const realCreate = src.create;
    let n = 0;
    src.create = vi.fn(async (t, rows) => {
      if (t === T.subEvent && ++n === 2) throw new Error("boom");
      return realCreate(t, rows);
    });
    expect(await apply(src)).toBe(1);
    expect(logs.join("\n")).toMatch(/Applied: SubEvent dibuat=10/);
    const audit = created.filter((c) => c.table === T.auditKep);
    expect(String(audit[0].rows[0][F.auditKep.sesudah])).toContain('"gagal":true');
    src.create = realCreate;
    expect(await apply(src, ["--rerun"])).toBe(0);
    const g5 = store[T.subEvent].filter((r) => (r.fields[F.subEvent.acara] as string[])?.[0] === "recEV_G5");
    const keys = g5.map((r) => r.fields[F.subEvent.keterangan]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(g5).toHaveLength(27);
    expect(g5.map((r) => r.fields[F.subEvent.urutan] as number).sort((a, b) => a - b)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
  });

  it("audit write failure still prints counts and exits non-zero", async () => {
    const src = memorySource();
    const realCreate = src.create;
    src.create = vi.fn(async (t, rows) => {
      if (t === T.auditKep) throw new Error("audit down");
      return realCreate(t, rows);
    });
    expect(await apply(src)).toBe(1);
    expect(logs.join("\n")).toMatch(/Applied: SubEvent dibuat=4/);
    expect(logs.join("\n")).toMatch(/audit row NOT written/);
  });

  it("re-reads before each batch and skips targets that became non-empty", async () => {
    const plan = buildPlan(store);
    const src = memorySource();
    store[T.eventKep].find((r) => r.id === "recKEP_G5")!.fields[F.eventKep.events] = ["recEV_OTHER"];
    const res = await applyPlan(src, { ...plan, subEvents: [], penyelenggaraUpdates: [] }, async () => {});
    expect(res.counts.events_diisi).toBe(0);
    expect(res.counts.dilewati).toBe(1);
    expect(src.update).not.toHaveBeenCalled();
  });
});

describe("map-legacy planning details", () => {
  it("folds accents when matching parish names", () => {
    store[T.paroki].push({ id: "recPAR_ACC", fields: { [F.paroki.nama]: "Santa Maria Tak Bernoda Café" } });
    store[T.penyelenggaraKep].push({ id: "recORG_ACC", fields: { [F.penyelenggaraKep.penyelenggara]: "Santa Maria Tak Bernoda Cafe" } });
    const plan = buildPlan(store);
    expect(plan.penyelenggaraUpdates.find((u) => u.id === "recORG_ACC")?.fields[F.penyelenggaraKep.paroki]).toEqual(["recPAR_ACC"]);
  });

  it("reports KEP events whose angkatan cannot be parsed, notes the parish source, and has note lines + hash", async () => {
    store[T.events].push({ id: "recEV_NOANG", fields: { [F.events.namaAcara]: "KEP Paroki Ganesha Perdana", [F.events.kelompokAcara]: ["KEP"] } });
    await run([], memorySource());
    expect(withJenis("tidak cocok").join("\n")).toMatch(/recEV_NOANG,.*angkatan tak terbaca/);
    expect(csv()).toContain("paroki dari nama penyelenggara");
    expect(csv()).toMatch(/Plan hash: [0-9a-f]{64}/);
    expect(csv()).toContain("Urutan SubEvent baru ditambahkan setelah");
  });
});
