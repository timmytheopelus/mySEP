import "server-only";
import { cachedList } from "@/lib/airtable/cache";
import { F, T } from "@/lib/airtable/schema";
import { assertKepInScope, listKepInScope, listLinkedToEvents, listPesertaInScope, requireRole } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import { MUNDUR, peopleOf } from "@/lib/kep/absensi";

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
  /** PIC only: pewarta assignment, registration link, import (Admin Paroki: none of these; manual peserta is allowed for Admin, owner-decided 2026-11-07). */
  pic: boolean;
  /** SEP may set the pewarta of any KEP that is not rejected. */
  sepJadwal: boolean;
  /** Pewarta assignment is open only while Diajukan. */
  jadwalTerkunci: boolean;
  /** Absen / penetapan need a Disetujui KEP. */
  absenTersedia: boolean;
  statistik: { aktif: number; mundur: number; lulus: number; tidakLulus: number; total: number };
  pertemuan: { id: string; urutan: number; agenda: string; tanggal: string; hadir: number; aktif: number; pengajarDitugaskan: boolean; hariIni: boolean }[];
  /** Today's pertemuan, else the next one, else the last one (what "Absen hari ini" opens). */
  pertemuanBerikutnya: string | null;
  /** PIC / Admin of the owning paroki: may read the health screen (SEP never). */
  medis: boolean;
  /** Peserta (not mundur) whose email or birth date is still missing, e.g. walk-ins. A count only; 0 for SEP. */
  belumLengkap: number;
  /** Names + status (+ whether the record is incomplete) only, never health or contact data. Absent for SEP. */
  peserta?: { id: string; nama: string; status: PesertaStatus; belumLengkap: boolean }[];
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
  const rec = eventKep; // cached scope row (45 s) carries status, angkatan and dates: no extra read
  const status = str(rec.fields[F.eventKep.statusPersetujuan]);
  const angkatan = typeof rec.fields[F.eventKep.angkatan] === "number" ? (rec.fields[F.eventKep.angkatan] as number) : null;

  let nama = "";
  if (eventIds[0] && /^rec[A-Za-z0-9]{10,}$/.test(eventIds[0])) {
    try {
      const ev = await cachedList(T.events, [F.events.namaAcara], `RECORD_ID()="${eventIds[0]}"`, { ttlMs: 10 * 60_000 });
      nama = str(ev.find((e) => e.id === eventIds[0])?.fields[F.events.namaAcara]).trim();
    } catch {
      /* fall back below */
    }
  }

  const [pend, subs] = await Promise.all([
    listPesertaInScope(session, [P.teamUmat, P.statusPendaftaran, P.kategoriKepesertaan, P.keterangan, P.pertemuanHadir], eventKepId),
    // only this KEP's pertemuan (EventID filter, cached), never the whole SubEvent table
    listLinkedToEvents(T.subEvent, F.subEvent.acara, [F.subEvent.acara, F.subEvent.agenda, F.subEvent.tanggal, F.subEvent.urutan, F.subEvent.pengajar], eventIds),
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
    sepJadwal: session.role === "SEP" && status !== "Ditolak",
    jadwalTerkunci: status !== "Diajukan",
    absenTersedia: kelola && status === "Disetujui",
    medis: kelola,
    belumLengkap: 0,
    statistik,
    pertemuan,
    pertemuanBerikutnya: berikut?.id ?? null,
  };
  if (kelola) {
    const people = await peopleOf(rows.flatMap((x) => ids(x.r.fields[P.teamUmat]).slice(0, 1)));
    hub.peserta = rows
      .map((x) => {
        const person = people.get(ids(x.r.fields[P.teamUmat])[0] ?? "");
        return { id: x.r.id, nama: person?.nama || "(tanpa nama)", status: x.status, belumLengkap: !!person && !person.lengkap };
      })
      .sort((a, b) => a.nama.localeCompare(b.nama, "id", { sensitivity: "base" }) || a.id.localeCompare(b.id));
    hub.belumLengkap = hub.peserta.filter((p) => p.belumLengkap && p.status !== "Mundur").length;
  }
  return hub;
}

export type KepIndexItem = { id: string; nama: string; angkatan: number | null; status: string; tanggalMulai: string | null };

/** KEPs the actor may see: PIC/Admin their own parish, SEP all. Names from the linked Events row. */
export async function listKepIndex(session: Session): Promise<KepIndexItem[]> {
  requireRole(session, ["SEP", "PIC", "ADMIN"]);
  // The scope list (cached) carries events, status, angkatan and tanggal mulai.
  const keps = await listKepInScope(session);
  // Names of exactly these events (RECORD_ID chunks, cached), never the whole Events table.
  const want = [...new Set(keps.flatMap((k) => ids(k.fields[F.eventKep.events]).slice(0, 1)))].filter((i) => /^rec[A-Za-z0-9]{10,}$/.test(i)).sort();
  const events = (
    await Promise.all(
      Array.from({ length: Math.ceil(want.length / 15) }, (_, i) =>
        cachedList(T.events, [F.events.namaAcara], `OR(${want.slice(i * 15, i * 15 + 15).map((id) => `RECORD_ID()="${id}"`).join(",")})`, { ttlMs: 10 * 60_000 }),
      ),
    )
  ).flat();
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
