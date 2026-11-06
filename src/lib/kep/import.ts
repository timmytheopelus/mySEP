import "server-only";
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
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

/** Little-endian ZIP writer for already-inflated, already-checked entries (stored, honest sizes). */
function rebuildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    parts.push(lh, name, e.data);
    central.push(ch, name);
    off += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

/**
 * Validates the archive and returns a rebuilt copy. Declared sizes are never trusted: every entry is inflated here
 * with a hard output budget, its real length must equal the central-directory size AND the local-header size, and
 * exceljs only ever sees the rebuilt archive made of those checked buffers.
 */
function checkZip(buf: Buffer): Buffer {
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
  const keep = out.filter((e) => KEEP.test(e.name));
  const sheets = keep.filter((e) => SHEET.test(e.name));
  if (sheets.length === 0 || sheets.length > MAX_SHEETS) reject("Berkas Excel tidak sesuai template");
  for (const sh of sheets) sh.data = Buffer.from(scanSheet(sh.data.toString("utf8")));
  return rebuildZip(keep);
}

// Only what the import needs survives; everything else (docProps, drawings, comments, external links, ...) is dropped.
const KEEP = /^(\[Content_Types\]\.xml|_rels\/\.rels|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/styles\.xml|xl\/worksheets\/sheet\d+\.xml)$/;
const SHEET = /^xl\/worksheets\/sheet\d+\.xml$/;
const MAX_SHEETS = 5;

const colNum = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
function refWithin(ref: string): boolean {
  for (const tok of ref.split(/[\s:]+/).filter(Boolean)) {
    const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/.exec(tok);
    if (!m || colNum(m[1]) > MAX_SHEET_COLS || Number(m[2]) > MAX_SHEET_ROWS) return false;
  }
  return true;
}
/** Raw-XML pre-scan (the XML is already budget capped): anything exceljs would EXPAND is refused before it loads. */
function scanSheet(xml: string): string {
  const bad = () => reject("Berkas Excel tidak sesuai template (struktur lembar tidak didukung)");
  if (/<mergeCells\b|<conditionalFormatting\b/.test(xml)) bad();
  for (const m of xml.matchAll(/\b(?:sqref|ref)="([^"]*)"/g)) if (!refWithin(m[1])) bad();
  for (const m of xml.matchAll(/<col\b[^>]*>/g)) {
    const mn = /\bmin="(\d+)"/.exec(m[0]);
    const mx = /\bmax="(\d+)"/.exec(m[0]);
    if (!mn || !mx || Number(mn[1]) > MAX_SHEET_COLS || Number(mx[1]) > MAX_SHEET_COLS) bad();
  }
  for (const m of xml.matchAll(/<c\s[^>]*?\br="([A-Z]+)(\d+)"/g)) if (colNum(m[1]) > MAX_SHEET_COLS || Number(m[2]) > MAX_SHEET_ROWS) bad();
  for (const m of xml.matchAll(/<row\s[^>]*?\br="(\d+)"/g)) if (Number(m[1]) > MAX_SHEET_ROWS) bad();
  // Parts that need relationships we dropped (links, drawings, tables) are removed; the cell text itself stays.
  return xml.replace(/<hyperlinks>[\s\S]*?<\/hyperlinks>|<(?:drawing|legacyDrawing|tableParts|picture)\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:tableParts|drawing|legacyDrawing|picture)>)/g, "");
}

// ---------------------------------------------------------------------------------------------
// Cell -> plain text
// ---------------------------------------------------------------------------------------------
function plain(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o && ("formula" in o || "sharedFormula" in o)) return plain(o.result); // text result only, never evaluated
    if ("formula" in o || "sharedFormula" in o) return null;
    if (Array.isArray(o.richText)) return o.richText.map((r) => String((r as { text?: unknown }).text ?? "")).join("");
    if ("text" in o) return plain(o.text); // hyperlink
    if ("error" in o) return null;
  }
  return null;
}
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function cellText(v: unknown, col: Col): string {
  const x = plain(v);
  if (x === null) return "";
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? "" : isoDate(x);
  if (typeof x === "number") {
    const s = String(x);
    // Excel drops the leading zero of a phone number typed as a number.
    return PHONE_COLS.includes(col) && /^8\d+$/.test(s) ? `0${s}` : s;
  }
  if (typeof x === "boolean") return x ? "ya" : "tidak";
  return x.trim(); // stored as typed; neutralize() is for cells we WRITE into a sheet
}

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
  const safe = checkZip(buf);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(safe as unknown as ArrayBuffer);
  } catch {
    return reject("Berkas bukan Excel (.xlsx) yang sah");
  }
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], items: [], errors: [] };
  if (ws.rowCount > MAX_SHEET_ROWS || ws.columnCount > MAX_SHEET_COLS) reject(`Lembar terlalu besar. Maksimal ${MAX_ROWS} baris data`);

  const colIndex = new Map<Col, number>();
  const head = ws.getRow(1);
  head.eachCell({ includeEmpty: false }, (cell, n) => {
    const t = String(plain(cell.value) ?? "").trim().toLowerCase();
    const col = COLS.find((c) => c.toLowerCase() === t);
    if (col && !colIndex.has(col)) colIndex.set(col, n);
  });
  const missing = COLS.filter((c) => !colIndex.has(c) && !OPTIONAL.includes(c));
  if (missing.length) reject(`Kolom tidak ditemukan: ${missing.join(", ")}. Gunakan template terbaru.`);

  const result: ImportResult = { rows: [], items: [], errors: [] };
  let dataRows = 0;
  const rowNums: number[] = [];
  ws.eachRow({ includeEmpty: false }, (_row, n) => {
    if (n >= 2) rowNums.push(n);
  });
  for (const r of rowNums) {
    const row = ws.getRow(r);
    const cells = {} as Record<Col, string>;
    let any = false;
    for (const c of COLS) {
      const n = colIndex.get(c);
      cells[c] = n ? cellText(row.getCell(n).value, c) : "";
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
