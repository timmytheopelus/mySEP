import "server-only";
import { getRecord, listRecords } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { assertKepInScope, listKepInScope, listPesertaInScope, requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { MUNDUR, namesOf } from "@/lib/kep/absensi";

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const day = (v: unknown) => str(v).slice(0, 10);
const todayWib = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const P = F.pendaftaranEvents;
const INACTIVE = new Set(["batal", "dobel daftar"]);

export type PesertaStatus = "Aktif" | "Mundur" | "Lulus" | "Tidak lulus";
export type KepHub = {
  id: string;
  nama: string;
  angkatan: number | null;
  status: string;
  tanggalMulai: string | null;
  tanggalSelesai: string | null;
  /** PIC / Admin of the owning paroki: may manage (add peserta, link, jadwal). SEP reads aggregates only. */
  kelola: boolean;
  /** PIC only: pewarta assignment, registration link, manual peserta, import (Admin Paroki: none of these). */
  pic: boolean;
  /** Pewarta assignment is open only while Diajukan. */
  jadwalTerkunci: boolean;
  /** Absen / penetapan need a Disetujui KEP. */
  absenTersedia: boolean;
  statistik: { aktif: number; mundur: number; lulus: number; tidakLulus: number; total: number };
  pertemuan: { id: string; urutan: number; agenda: string; tanggal: string; hadir: number; aktif: number; pengajarDitugaskan: boolean; hariIni: boolean }[];
  /** Today's pertemuan, else the next one, else the last one (what "Absen hari ini" opens). */
  pertemuanBerikutnya: string | null;
  /** Names + status only, never health or contact data. Absent for SEP. */
  peserta?: { id: string; nama: string; status: PesertaStatus }[];
};

function statusOf(keterangan: string): PesertaStatus {
  const k = keterangan.trim().toUpperCase();
  if (k === MUNDUR) return "Mundur";
  if (k === "LULUS") return "Lulus";
  if (k === "TIDAK LULUS") return "Tidak lulus";
  return "Aktif";
}

/**
 * Detail KEP for the hub page. Peserta rows are read with an explicit, health-free field list; SEP gets
 * aggregates only (spec: health and personal data belong to the owning paroki).
 */
export async function getKepHub(session: Session, eventKepId: string): Promise<KepHub> {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  const { eventKep } = await assertKepInScope(session, eventKepId); // 404 for foreign / unknown / malformed
  const eventIds = ids(eventKep.fields[F.eventKep.events]);
  const rec = await getRecord(T.eventKep, eventKepId);
  const status = str(rec.fields[F.eventKep.statusPersetujuan]) || str(eventKep.fields[F.eventKep.statusPersetujuan]);
  const angkatan = typeof rec.fields[F.eventKep.angkatan] === "number" ? (rec.fields[F.eventKep.angkatan] as number) : null;

  let nama = "";
  if (eventIds[0]) {
    try {
      nama = str((await getRecord(T.events, eventIds[0])).fields[F.events.namaAcara]).trim();
    } catch {
      /* fall back below */
    }
  }

  const [pend, subs] = await Promise.all([
    listPesertaInScope(session, [P.teamUmat, P.statusPendaftaran, P.kategoriKepesertaan, P.keterangan, P.pertemuanHadir], eventKepId),
    listRecords(T.subEvent, { fields: [F.subEvent.acara, F.subEvent.agenda, F.subEvent.tanggal, F.subEvent.urutan, F.subEvent.pengajar] }),
  ]);
  const countable = pend.filter(
    (r) => !INACTIVE.has(str(r.fields[P.statusPendaftaran]).toLowerCase()) && str(r.fields[P.kategoriKepesertaan]).toLowerCase() !== "panitia",
  );
  const rows = countable.map((r) => ({ r, status: statusOf(str(r.fields[P.keterangan])) }));
  const statistik = {
    aktif: rows.filter((x) => x.status === "Aktif").length,
    mundur: rows.filter((x) => x.status === "Mundur").length,
    lulus: rows.filter((x) => x.status === "Lulus").length,
    tidakLulus: rows.filter((x) => x.status === "Tidak lulus").length,
    total: rows.length,
  };

  const today = todayWib();
  const pertemuan = subs
    .filter((s) => ids(s.fields[F.subEvent.acara]).some((e) => eventIds.includes(e)))
    .map((s) => {
      const hadirRows = rows.filter((x) => x.status !== "Mundur" && ids(x.r.fields[P.pertemuanHadir]).includes(s.id));
      return {
        id: s.id,
        urutan: Number(s.fields[F.subEvent.urutan]) || 0,
        agenda: str(s.fields[F.subEvent.agenda]),
        tanggal: day(s.fields[F.subEvent.tanggal]),
        hadir: hadirRows.length,
        aktif: rows.filter((x) => x.status !== "Mundur").length,
        pengajarDitugaskan: ids(s.fields[F.subEvent.pengajar]).length > 0,
        hariIni: day(s.fields[F.subEvent.tanggal]) === today,
      };
    })
    .sort((a, b) => a.tanggal.localeCompare(b.tanggal) || a.urutan - b.urutan || a.id.localeCompare(b.id));
  const berikut = pertemuan.find((p) => p.hariIni) ?? pertemuan.find((p) => p.tanggal > today) ?? pertemuan.at(-1);

  const kelola = session.role !== "SEP";
  const hub: KepHub = {
    id: eventKepId,
    nama: nama || (angkatan ? `KEP Angkatan ${angkatan}` : "KEP"),
    angkatan,
    status,
    tanggalMulai: day(rec.fields[F.eventKep.tanggalMulai]) || null,
    tanggalSelesai: day(rec.fields[F.eventKep.tanggalSelesai]) || null,
    kelola,
    pic: session.role === "PIC",
    jadwalTerkunci: status !== "Diajukan",
    absenTersedia: kelola && status === "Disetujui",
    statistik,
    pertemuan,
    pertemuanBerikutnya: berikut?.id ?? null,
  };
  if (kelola) {
    const names = await namesOf(rows.flatMap((x) => ids(x.r.fields[P.teamUmat]).slice(0, 1)));
    hub.peserta = rows
      .map((x) => ({ id: x.r.id, nama: names.get(ids(x.r.fields[P.teamUmat])[0] ?? "") || "(tanpa nama)", status: x.status }))
      .sort((a, b) => a.nama.localeCompare(b.nama, "id", { sensitivity: "base" }) || a.id.localeCompare(b.id));
  }
  return hub;
}

export type KepIndexItem = { id: string; nama: string; angkatan: number | null; status: string; tanggalMulai: string | null };

/** KEPs the actor may see: PIC/Admin their own parish, SEP all. Names from the linked Events row. */
export async function listKepIndex(session: Session): Promise<KepIndexItem[]> {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  const inScope = new Set((await listKepInScope(session)).map((k) => k.id));
  // The scope list only carries the fields the guard needs; angkatan / dates are read here.
  const [all, events] = await Promise.all([
    listRecords(T.eventKep, { fields: [F.eventKep.events, F.eventKep.statusPersetujuan, F.eventKep.angkatan, F.eventKep.tanggalMulai] }),
    listRecords(T.events, { fields: [F.events.namaAcara] }),
  ]);
  const keps = all.filter((k) => inScope.has(k.id));
  const nameOf = new Map(events.map((e) => [e.id, str(e.fields[F.events.namaAcara]).trim()]));
  const out: KepIndexItem[] = [];
  for (const k of keps) {
    const angkatan = typeof k.fields[F.eventKep.angkatan] === "number" ? (k.fields[F.eventKep.angkatan] as number) : null;
    out.push({
      id: k.id,
      nama: nameOf.get(ids(k.fields[F.eventKep.events])[0] ?? "") || (angkatan ? `KEP Angkatan ${angkatan}` : "KEP"),
      angkatan,
      status: str(k.fields[F.eventKep.statusPersetujuan]),
      tanggalMulai: day(k.fields[F.eventKep.tanggalMulai]) || null,
    });
  }
  return out.sort((a, b) => (b.tanggalMulai ?? "").localeCompare(a.tanggalMulai ?? "") || a.nama.localeCompare(b.nama, "id"));
}
