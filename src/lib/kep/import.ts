import "server-only";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SaxesParser } from "saxes";
import ExcelJS from "exceljs";
import { neutralize } from "@/lib/security/csv";
import { PesertaInput } from "@/lib/kep/registration";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 500;
const MAX_UNCOMPRESSED = 20 * 1024 * 1024;
const MAX_ENTRIES = 200;
const MAX_ENTRY_BYTES = 15 * 1024 * 1024;
const REC_ID = /^rec[A-Za-z0-9]{10,}$/;

export class ImportFileError extends Error {
  constructor(message: string, public readonly status: 413 | 422 = 422) {
    super(message);
    this.name = "ImportFileError";
  }
}

export const fileHash = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------------------------------------
// Columns (same fields as PesertaInput)
// ---------------------------------------------------------------------------------------------
const COLS = [
  "Nama Lengkap", "Nama Baptis", "Jenis Kelamin", "Tanggal Lahir", "Nomor WhatsApp", "Email", "Alamat", "Paroki Asal",
  "Status Pernikahan", "Kontak Darurat", "Pendukung Doa 1 Nama", "Pendukung Doa 1 Kontak", "Pendukung Doa 2 Nama",
  "Pendukung Doa 2 Kontak", "Riwayat Penyakit", "Riwayat Alergi", "Obat Rutin", "Persetujuan Data Kesehatan",
] as const;
type Col = (typeof COLS)[number];
const OPTIONAL: Col[] = ["Nama Baptis", "Riwayat Penyakit", "Riwayat Alergi", "Obat Rutin", "Persetujuan Data Kesehatan"];
const EXAMPLE: Record<Col, string> = {
  "Nama Lengkap": "CONTOH Maria Goreti (hapus baris ini)",
  "Nama Baptis": "Maria",
  "Jenis Kelamin": "Wanita",
  "Tanggal Lahir": "1985-04-12",
  "Nomor WhatsApp": "081234567890",
  Email: "contoh@example.com",
  Alamat: "Jl. Contoh No. 1, Bandung",
  "Paroki Asal": "Nama paroki",
  "Status Pernikahan": "Menikah",
  "Kontak Darurat": "Yohanes 081111111111",
  "Pendukung Doa 1 Nama": "Ana",
  "Pendukung Doa 1 Kontak": "081200000001",
  "Pendukung Doa 2 Nama": "Budi",
  "Pendukung Doa 2 Kontak": "081200000002",
  "Riwayat Penyakit": "",
  "Riwayat Alergi": "",
  "Obat Rutin": "",
  "Persetujuan Data Kesehatan": "tidak",
};
const PHONE_COLS: Col[] = ["Nomor WhatsApp", "Kontak Darurat", "Pendukung Doa 1 Kontak", "Pendukung Doa 2 Kontak"];
const MAX_SHEET_ROWS = 600;
const MAX_SHEET_COLS = 60;

export async function buildTemplateXlsx(opts: { parokiNames?: string[] } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Peserta");
  ws.addRow([...COLS]);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.columns.forEach((c, i) => {
    c.width = Math.max(16, COLS[i].length + 4);
  });
  // Every string written into a sheet goes through neutralize(); any future export MUST do the same.
  ws.addRow(COLS.map((c) => neutralize(c === "Paroki Asal" ? (opts.parokiNames?.[0] ?? EXAMPLE[c]) : EXAMPLE[c])));
  ws.getRow(2).font = { italic: true, color: { argb: "FF888888" } };
  // Phone, date and name columns are text so Excel does not drop leading zeros or reinterpret dates.
  for (const c of ["Tanggal Lahir", "Nomor WhatsApp", "Pendukung Doa 1 Kontak", "Pendukung Doa 2 Kontak", "Kontak Darurat"] as Col[]) {
    ws.getColumn(COLS.indexOf(c) + 1).numFmt = "@";
  }
  const list = (c: Col, items: string[]) => {
    for (let r = 2; r <= MAX_ROWS + 1; r++)
      ws.getCell(r, COLS.indexOf(c) + 1).dataValidation = { type: "list", allowBlank: true, formulae: [`"${items.join(",")}"`] };
  };
  list("Jenis Kelamin", ["Pria", "Wanita"]);
  list("Status Pernikahan", ["Single", "Menikah", "Tidak Menikah"]);
  list("Persetujuan Data Kesehatan", ["ya", "tidak"]);

  const help = wb.addWorksheet("Petunjuk");
  [
    "Isi data mulai baris 2 pada lembar Peserta. Hapus atau ganti baris CONTOH.",
    "Maksimal 500 baris, ukuran berkas maksimal 2 MB, format .xlsx tanpa makro.",
    "Tanggal Lahir: YYYY-MM-DD (contoh 1985-04-12). Nomor WhatsApp: awali dengan 0 atau 62.",
    "Paroki Asal: tulis nama paroki persis seperti pada lembar Daftar Paroki.",
    "Dua pendukung doa wajib diisi (nama dan kontak).",
    "Kolom kesehatan boleh dikosongkan. Jika diisi, kolom Persetujuan Data Kesehatan harus berisi: ya.",
  ].forEach((t) => help.addRow([t]));
  help.getColumn(1).width = 100;
  if (opts.parokiNames?.length) {
    const pw = wb.addWorksheet("Daftar Paroki");
    pw.addRow(["Nama Paroki"]).font = { bold: true };
    opts.parokiNames.forEach((n) => pw.addRow([neutralize(n)]));
    pw.getColumn(1).width = 40;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------------------------
// ZIP safety (read the central directory ourselves; nothing is inflated before these checks pass)
// ---------------------------------------------------------------------------------------------
const reject = (m: string): never => {
  throw new ImportFileError(m);
};

/**
 * Validates the archive and returns its checked, inflated entries. Declared sizes are never trusted: every entry is inflated here
 * with a hard output budget, its real length must equal the central-directory size AND the local-header size, and
 * the reader below only ever sees those checked buffers (exceljs is never used to read uploads).
 */
function checkZip(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) reject("Berkas bukan Excel (.xlsx) yang sah");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return reject("Berkas bukan Excel (.xlsx) yang sah");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) reject("Berkas Excel tidak wajar (terlalu banyak komponen)");
  if (count === 0xffff || cdOff === 0xffffffff || cdOff + cdSize > buf.length) reject("Berkas bukan Excel (.xlsx) yang sah");

  let p = cdOff;
  let budget = MAX_UNCOMPRESSED;
  const out: { name: string; data: Buffer }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return reject("Berkas bukan Excel (.xlsx) yang sah");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    if (csize === 0xffffffff || usize === 0xffffffff) reject("Berkas Excel tidak didukung");
    if (flags & 1) reject("Berkas Excel yang dienkripsi tidak didukung");
    if (/(^|\/)vbaproject\.bin$/i.test(name) || (/\.bin$/i.test(name) && /vba/i.test(name))) reject("Berkas berisi makro dan ditolak");
    if (name.includes("..") || name.startsWith("/") || name.includes("\\") || seen.has(name)) reject("Berkas Excel tidak valid");
    seen.add(name);
    if (name.endsWith("/")) continue; // directory entry
    if (usize > MAX_ENTRY_BYTES || usize > budget) reject("Isi berkas Excel terlalu besar setelah dibuka");
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) return reject("Berkas bukan Excel (.xlsx) yang sah");
    const lflags = buf.readUInt16LE(off + 6);
    const lcsize = buf.readUInt32LE(off + 18);
    const lusize = buf.readUInt32LE(off + 22);
    // With a data descriptor (bit 3) the local sizes are legitimately 0; otherwise they must match the central directory.
    if (!(lflags & 8) && (lcsize !== csize || lusize !== usize)) reject("Berkas Excel tidak konsisten");
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    if (start + csize > buf.length) reject("Berkas bukan Excel (.xlsx) yang sah");
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(budget, usize + 1)) });
      else return reject("Berkas Excel tidak didukung");
    } catch {
      return reject("Berkas Excel rusak atau terlalu besar setelah dibuka");
    }
    if (data.length !== usize) reject("Berkas Excel tidak konsisten");
    budget -= data.length;
    out.push({ name, data });
  }
  const ctEntry = out.find((e) => e.name === "[Content_Types].xml");
  if (!ctEntry) return reject("Berkas bukan Excel (.xlsx) yang sah");
  const ct = ctEntry.data.toString("utf8");
  if (/macroEnabled|vbaProject/i.test(ct)) reject("Berkas berisi makro dan ditolak");
  if (!/spreadsheetml\.sheet\.main/.test(ct)) reject("Berkas bukan Excel (.xlsx) yang sah");
  return new Map(out.map((e) => [e.name, e.data]));
}

const colNum = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
// ---------------------------------------------------------------------------------------------
// Minimal streaming reader (saxes). Only rows/cells of the first sheet are looked at; merges, validations, cols,
// definedNames, styles, other sheets, drawings and hyperlinks are never read. No DTD, no entity expansion.
// ---------------------------------------------------------------------------------------------
type Raw = string | number | boolean;
const MAX_CELLS = 20_000;
const MAX_CELL_CHARS = 2000;
const MAX_SHARED = 50_000;
const local = (n: string) => n.slice(n.lastIndexOf(":") + 1);
const bad = (m = "Berkas bukan Excel (.xlsx) yang sah") => reject(m);

function sax(xml: string, h: { open?: (name: string, attrs: Record<string, string>) => void; close?: (name: string) => void; text?: (t: string) => void }): void {
  const p = new SaxesParser({ xmlns: false });
  p.on("error", () => bad());
  p.on("doctype", () => bad());
  p.on("opentag", (t) => h.open?.(local(t.name), t.attributes as Record<string, string>));
  p.on("closetag", (t) => h.close?.(local(t.name)));
  p.on("text", (t) => h.text?.(t));
  try {
    p.write(xml).close();
  } catch (e) {
    if (e instanceof ImportFileError) throw e;
    bad();
  }
}

function sharedStrings(xml: string | undefined): string[] {
  const out: string[] = [];
  if (!xml) return out;
  let cur = "";
  let inT = false;
  let skip = 0; // inside <rPh> (phonetic runs)
  sax(xml, {
    open(n) {
      if (n === "si") cur = "";
      else if (n === "rPh") skip++;
      else if (n === "t" && !skip) inT = true;
    },
    close(n) {
      if (n === "t") inT = false;
      else if (n === "rPh") skip--;
      else if (n === "si") {
        if (out.length >= MAX_SHARED) bad("Berkas Excel terlalu rumit");
        out.push(cur);
      }
    },
    text(t) {
      if (inT && cur.length <= MAX_CELL_CHARS) cur = (cur + t).slice(0, MAX_CELL_CHARS + 1);
    },
  });
  return out;
}

/** The first sheet listed in workbook.xml, resolved through its relationships. */
function firstSheetPath(files: Map<string, Buffer>): string {
  const wbXml = files.get("xl/workbook.xml")?.toString("utf8");
  const relXml = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!wbXml || !relXml) return bad();
  let rid: string | null = null;
  sax(wbXml, {
    open(n, a) {
      if (n === "sheet" && rid === null) rid = a["r:id"] ?? a.id ?? null;
    },
  });
  let target: string | null = null;
  sax(relXml, {
    open(n, a) {
      if (n === "Relationship" && a.Id === rid) target = a.Target ?? null;
    },
  });
  if (!target) return bad();
  const path = (target as string).startsWith("/") ? (target as string).slice(1) : `xl/${target}`;
  if (!/^xl\/worksheets\/[A-Za-z0-9_-]+\.xml$/.test(path)) return bad();
  return path;
}

function readSheet(files: Map<string, Buffer>): Map<number, Map<number, Raw>> {
  const sheetXml = files.get(firstSheetPath(files))?.toString("utf8");
  if (!sheetXml) return bad();
  const strings = sharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8"));
  const rows = new Map<number, Map<number, Raw>>();
  let cell: { row: number; col: number; t: string; v: string; is: string } | null = null;
  let cap: "v" | "is" | null = null;
  let inIs = 0;
  let count = 0;
  const add = (c: NonNullable<typeof cell>) => {
    let val: Raw | null = null;
    const raw = c.t === "inlineStr" ? c.is : c.v;
    if (c.t === "s") {
      const i = Number(raw);
      if (!Number.isInteger(i) || i < 0 || i >= strings.length) bad();
      val = strings[i];
    } else if (c.t === "b") val = raw.trim() === "1";
    else if (c.t === "e") val = null;
    else if (c.t === "str" || c.t === "inlineStr" || c.t === "d") val = raw;
    else if (raw.trim() !== "") {
      const n = Number(raw);
      val = Number.isFinite(n) ? n : raw;
    }
    if (typeof val === "string" && val.length > MAX_CELL_CHARS) bad(`Teks pada baris ${c.row} terlalu panjang (maksimal ${MAX_CELL_CHARS} karakter)`);
    if (val === null || val === "") return;
    let r = rows.get(c.row);
    if (!r) rows.set(c.row, (r = new Map()));
    r.set(c.col, val);
  };
  sax(sheetXml, {
    open(n, a) {
      if (n === "c") {
        const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(a.r ?? "");
        if (!m) bad("Berkas Excel tidak valid: ada sel tanpa alamat yang sah");
        const col = colNum(m![1]);
        const row = Number(m![2]);
        if (col > MAX_SHEET_COLS || row > MAX_SHEET_ROWS) bad(`Data di luar batas lembar (maksimal ${MAX_ROWS} baris dan ${MAX_SHEET_COLS} kolom)`);
        if (++count > MAX_CELLS) bad("Berkas Excel terlalu rumit (terlalu banyak sel)");
        cell = { row, col, t: a.t ?? "n", v: "", is: "" };
      } else if (cell && n === "v") cap = "v";
      else if (cell && n === "is") inIs++;
      else if (cell && inIs && n === "t") cap = "is";
      else if (cell && inIs && n === "rPh") inIs++;
    },
    close(n) {
      if (n === "c" && cell) {
        add(cell);
        cell = null;
      } else if (n === "v" || n === "t") cap = null;
      else if (n === "is" || n === "rPh") inIs = Math.max(0, inIs - 1);
    },
    text(t) {
      if (!cell || !cap) return;
      if (cap === "v" && cell.v.length <= MAX_CELL_CHARS) cell.v = (cell.v + t).slice(0, MAX_CELL_CHARS + 1);
      else if (cap === "is" && inIs === 1 && cell.is.length <= MAX_CELL_CHARS) cell.is = (cell.is + t).slice(0, MAX_CELL_CHARS + 1);
    },
  });
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Cell -> plain text
// ---------------------------------------------------------------------------------------------
function cellText(x: Raw | undefined, col: Col): string {
  if (x === undefined) return "";
  if (typeof x === "number") {
    if (col === "Tanggal Lahir" && x >= 1 && x < 80000) return isoDate(new Date(Date.UTC(1899, 11, 30) + Math.floor(x) * 86400000)); // Excel serial date
    const s = String(x);
    // Excel drops the leading zero of a phone number typed as a number.
    return PHONE_COLS.includes(col) && /^8\d+$/.test(s) ? `0${s}` : s;
  }
  if (typeof x === "boolean") return x ? "ya" : "tidak";
  return x.trim(); // stored as typed; neutralize() is for cells we WRITE into a sheet
}
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function normDate(s: string): string {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : s;
}
const YES = new Set(["ya", "iya"]);

export type ParsedRow = { row: number; data: PesertaInput };
export type ImportResult = {
  rows: PesertaInput[];
  items: ParsedRow[];
  errors: { row: number; message: string }[];
};

export async function parseImport(buf: Buffer, opts: { parokiByName?: Map<string, string> } = {}): Promise<ImportResult> {
  if (buf.length > MAX_FILE_BYTES) throw new ImportFileError("Berkas lebih dari 2 MB", 413);
  const sheet = readSheet(checkZip(buf));

  const colIndex = new Map<Col, number>();
  for (const [n, v] of sheet.get(1) ?? []) {
    const t = cellText(v, "Nama Lengkap").toLowerCase();
    const col = COLS.find((c) => c.toLowerCase() === t);
    if (col && !colIndex.has(col)) colIndex.set(col, n);
  }
  const missing = COLS.filter((c) => !colIndex.has(c) && !OPTIONAL.includes(c));
  if (missing.length) reject(`Kolom tidak ditemukan: ${missing.join(", ")}. Gunakan template terbaru (baris 1 harus berisi judul kolom).`);

  const result: ImportResult = { rows: [], items: [], errors: [] };
  let dataRows = 0;
  const rowNums = [...sheet.keys()].filter((n) => n >= 2).sort((a, b) => a - b);
  for (const r of rowNums) {
    const row = sheet.get(r)!;
    const cells = {} as Record<Col, string>;
    let any = false;
    for (const c of COLS) {
      const n = colIndex.get(c);
      cells[c] = n ? cellText(row.get(n), c) : "";
      if (cells[c]) any = true;
    }
    if (!any) continue;
    if (++dataRows > MAX_ROWS) reject(`Maksimal ${MAX_ROWS} baris data per berkas`);

    if (cells["Nama Lengkap"] === EXAMPLE["Nama Lengkap"] || cells.Email.toLowerCase() === EXAMPLE.Email || COLS.every((c) => c === "Paroki Asal" || cells[c] === EXAMPLE[c])) {
      result.errors.push({ row: r, message: "Baris CONTOH dari template belum diganti atau dihapus" });
      continue;
    }
    const paroki = cells["Paroki Asal"];
    let parokiId = paroki;
    if (!REC_ID.test(paroki) && opts.parokiByName) {
      const hit = opts.parokiByName.get(paroki.toLowerCase());
      if (!hit) {
        result.errors.push({ row: r, message: "Paroki asal tidak dikenal. Pakai nama persis dari lembar Daftar Paroki" });
        continue;
      }
      parokiId = hit;
    }
    const parsed = PesertaInput.safeParse({
      namaLengkap: cells["Nama Lengkap"],
      namaBaptis: cells["Nama Baptis"] || undefined,
      jenisKelamin: cells["Jenis Kelamin"],
      tanggalLahir: normDate(cells["Tanggal Lahir"]),
      wa: cells["Nomor WhatsApp"],
      email: cells.Email,
      alamat: cells.Alamat,
      parokiAsalId: parokiId,
      statusPernikahan: cells["Status Pernikahan"],
      kontakDarurat: cells["Kontak Darurat"],
      pendukungDoa: [
        { nama: cells["Pendukung Doa 1 Nama"], kontak: cells["Pendukung Doa 1 Kontak"] },
        { nama: cells["Pendukung Doa 2 Nama"], kontak: cells["Pendukung Doa 2 Kontak"] },
      ],
      riwayatPenyakit: cells["Riwayat Penyakit"] || undefined,
      riwayatAlergi: cells["Riwayat Alergi"] || undefined,
      obatRutin: cells["Obat Rutin"] || undefined,
      persetujuanKesehatan: YES.has(cells["Persetujuan Data Kesehatan"].toLowerCase()) ? true : undefined,
    });
    if (parsed.success) {
      result.rows.push(parsed.data);
      result.items.push({ row: r, data: parsed.data });
    } else {
      const msgs = [...new Set(parsed.error.issues.map((i) => i.message))].slice(0, 4);
      result.errors.push({ row: r, message: msgs.join("; ") });
    }
  }
  return result;
}
