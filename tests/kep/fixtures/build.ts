import ExcelJS from "exceljs";
import { crc32, deflateRawSync } from "node:zlib";

/** Fixture generator (run at test time, nothing binary is committed). */
export const HEADERS = [
  "Nama Lengkap", "Nama Baptis", "Jenis Kelamin", "Tanggal Lahir", "Nomor WhatsApp", "Email", "Alamat", "Paroki Asal",
  "Status Pernikahan", "Kontak Darurat", "Pendukung Doa 1 Nama", "Pendukung Doa 1 Kontak", "Pendukung Doa 2 Nama",
  "Pendukung Doa 2 Kontak", "Riwayat Penyakit", "Riwayat Alergi", "Obat Rutin", "Persetujuan Data Kesehatan",
];

export type Row = Record<string, unknown>;
export const goodRow = (n = 1, over: Row = {}): Row => ({
  "Nama Lengkap": `Maria Goreti${String.fromCharCode(64 + (n % 26 || 26))}${String.fromCharCode(97 + ((n >> 5) % 26))}`,
  "Nama Baptis": "Maria",
  "Jenis Kelamin": "Wanita",
  "Tanggal Lahir": "1985-04-12",
  "Nomor WhatsApp": `08123${String(100000 + n)}`,
  Email: `peserta${n}@example.com`,
  Alamat: "Jl. Merdeka 1, Bandung",
  "Paroki Asal": "Pandu",
  "Status Pernikahan": "Menikah",
  "Kontak Darurat": "Yohanes 081111111111",
  "Pendukung Doa 1 Nama": "Ana",
  "Pendukung Doa 1 Kontak": "081200000001",
  "Pendukung Doa 2 Nama": "Budi",
  "Pendukung Doa 2 Kontak": "081200000002",
  ...over,
});

export async function xlsx(rows: Row[], opts: { headers?: string[] } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Peserta");
  const headers = opts.headers ?? HEADERS;
  ws.addRow(headers);
  for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
export const validXlsx = (n = 3) => xlsx(Array.from({ length: n }, (_, i) => goodRow(i + 1)));
export const emptyXlsx = () => xlsx([]);

/** Minimal ZIP writer. `lie` makes the central directory declare a huge uncompressed size. */
export function zip(entries: { name: string; data: Buffer; declaredSize?: number; localSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const comp = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.localSize ?? e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.declaredSize ?? e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const CT = (extra = "") =>
  Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>${extra}</Types>`);
export const macroXlsm = () =>
  zip([
    { name: "[Content_Types].xml", data: CT(`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>`) },
    { name: "xl/vbaProject.bin", data: Buffer.from("VBA") },
  ]);
export const vbaInPlainXlsx = async () => {
  // A normal workbook plus a vbaProject.bin entry and no macro content type.
  const base = await validXlsx(1);
  return zip([{ name: "[Content_Types].xml", data: CT() }, { name: "xl/vbaProject.bin", data: base.subarray(0, 10) }]);
};
export const zipBomb = () =>
  zip([
    { name: "[Content_Types].xml", data: CT() },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(30 * 1024 * 1024, 0x61) }, // ~30 KB compressed, 30 MB inflated
  ]);
export const lyingZip = () => zip([{ name: "[Content_Types].xml", data: CT(), declaredSize: 900 * 1024 * 1024 }]);

/** Both headers claim 1000 bytes while the entry really inflates to 30 MB. */
export const understatedBomb = () =>
  zip([
    { name: "[Content_Types].xml", data: CT() },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(30 * 1024 * 1024, 0x61), declaredSize: 1000, localSize: 1000 },
  ]);
/** Same, but modest (316 KB padded sheet) with understated sizes. */
export const understatedPadded = () =>
  zip([
    { name: "[Content_Types].xml", data: CT() },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(316 * 1024, 0x20), declaredSize: 1000, localSize: 1000 },
  ]);
export async function farRowXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Peserta");
  ws.addRow(HEADERS);
  ws.getCell(1048576, 1).value = " ";
  return Buffer.from(await wb.xlsx.writeBuffer());
}
