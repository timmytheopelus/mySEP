// Shared by the mock Airtable server and the specs: ids, secret and seed rows for the attendance e2e.
import { createHash } from "node:crypto";
import { F, T } from "../../src/lib/airtable/schema.ts";

export const SESSION_SECRET = "e2e-session-secret-0123456789-abcdefghij";
export const MOCK_PORT = 4010;

export const PA = "recE2EPAROKIA0001";
export const PB = "recE2EPAROKIB0001";
export const KEP_A = "recE2EKEPA0000001"; // 3 pertemuan: kemarin, hari ini, +7 hari; 8 peserta
export const KEP_B = "recE2EKEPB0000001"; // 1 pertemuan hari ini (penetapan terbuka); 2 peserta
export const KEP_C = "recE2EKEPC0000001"; // paroki lain
export const KEP_D = "recE2EKEPD0000001"; // Diajukan, paroki A: penugasan pewarta masih terbuka
export const SUB_A_TODAY = "recE2ESUBA0000002";
export const PENGAJAR_1 = "recE2EPENGAJAR001";
export const PENGAJAR_2 = "recE2EPENGAJAR002";
export const PENGAJAR_OFF = "recE2EPENGAJAR003";
export const ACC = {
  picA: { id: "recE2EPICA00000001", email: "pic-a@e2e.test", role: "PIC Paroki", paroki: PA },
  admA: { id: "recE2EADMA00000001", email: "adm-a@e2e.test", role: "Admin Paroki", paroki: PA },
  picB: { id: "recE2EPICB00000001", email: "pic-b@e2e.test", role: "PIC Paroki", paroki: PB },
  picX: { id: "recE2EPICX00000001", email: "pic-x@e2e.test", role: "PIC Paroki", paroki: null as string | null }, // akun tanpa paroki
  sep: { id: "recE2ESEP000000001", email: "sep@e2e.test", role: "SEP", paroki: null as string | null },
} as const;
export const PASSWORD_HASH = "e2e-password-hash";
export const MFA_ENC = "e2e-mfa-secret";
export const NAMES_A = ["Agnes Lestari", "Bernadus Wijaya", "Cecilia Hartono", "Dominikus Surya", "Elisabeth Tan", "Fransiskus Adi", "Gabriella Putri", "Hendrikus Lim"];

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
/** The `pf`/`sv` claims a session must carry for this account (mirrors src/lib/auth/session.ts). */
export const sessionClaims = (a: { role: string; paroki: string | null }) => ({
  pf: sha(PASSWORD_HASH),
  sv: sha([a.role.startsWith("SEP") ? "SEP" : a.role.startsWith("Admin") ? "ADMIN" : "PIC", a.paroki ?? "", "", MFA_ENC].join("|")),
});

const wib = (offsetDays: number) => new Date(Date.now() + 7 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

type Rows = Record<string, { id: string; fields: Record<string, unknown> }[]>;
const row = (id: string, fields: Record<string, unknown>) => ({ id, fields });

export function seedRows(): Rows {
  const pend = (id: string, ev: string, tu: string) =>
    row(id, { [F.pendaftaranEvents.event]: [ev], [F.pendaftaranEvents.teamUmat]: [tu], [F.pendaftaranEvents.statusPendaftaran]: "Daftar", [F.pendaftaranEvents.kategoriKepesertaan]: "Peserta" });
  const acc = (a: (typeof ACC)[keyof typeof ACC]) =>
    row(a.id, {
      [F.akunKep.email]: a.email,
      [F.akunKep.nama]: a.email,
      [F.akunKep.peran]: a.role,
      ...(a.paroki ? { [F.akunKep.paroki]: [a.paroki] } : {}),
      [F.akunKep.hashPassword]: PASSWORD_HASH,
      [F.akunKep.rahasiaMfa]: MFA_ENC,
      [F.akunKep.statusAktif]: true,
    });
  const sub = (id: string, ev: string, n: number, agenda: string, day: string) =>
    row(id, { [F.subEvent.agenda]: agenda, [F.subEvent.acara]: [ev], [F.subEvent.urutan]: n, [F.subEvent.tanggal]: day });
  return {
    [T.paroki]: [row(PA, { [F.paroki.nama]: "St. E2E A" }), row(PB, { [F.paroki.nama]: "St. E2E B" })],
    [T.penyelenggaraKep]: [
      row("recE2EORGA0000001", { [F.penyelenggaraKep.paroki]: [PA] }),
      row("recE2EORGB0000001", { [F.penyelenggaraKep.paroki]: [PB] }),
    ],
    [T.events]: [
      row("recE2EEVA00000001", { [F.events.namaAcara]: "KEP E2E A" }),
      row("recE2EEVA00000002", { [F.events.namaAcara]: "KEP E2E B" }),
      row("recE2EEVB00000001", { [F.events.namaAcara]: "KEP E2E C" }),
      row("recE2EEVD00000001", { [F.events.namaAcara]: "KEP E2E D" }),
    ],
    [T.eventKep]: [
      row(KEP_A, { [F.eventKep.events]: ["recE2EEVA00000001"], [F.eventKep.penyelenggara]: ["recE2EORGA0000001"], [F.eventKep.statusPersetujuan]: "Disetujui", [F.eventKep.angkatan]: 3, [F.eventKep.tanggalMulai]: wib(-8), [F.eventKep.tanggalSelesai]: wib(190) }),
      row(KEP_B, { [F.eventKep.events]: ["recE2EEVA00000002"], [F.eventKep.penyelenggara]: ["recE2EORGA0000001"], [F.eventKep.statusPersetujuan]: "Disetujui", [F.eventKep.angkatan]: 4 }),
      row(KEP_D, { [F.eventKep.events]: ["recE2EEVD00000001"], [F.eventKep.penyelenggara]: ["recE2EORGA0000001"], [F.eventKep.statusPersetujuan]: "Diajukan", [F.eventKep.angkatan]: 5 }),
      row(KEP_C, { [F.eventKep.events]: ["recE2EEVB00000001"], [F.eventKep.penyelenggara]: ["recE2EORGB0000001"], [F.eventKep.statusPersetujuan]: "Disetujui" }),
    ],
    [T.subEvent]: [
      sub("recE2ESUBA0000001", "recE2EEVA00000001", 1, "Pertemuan 1 - Pengantar", wib(-1)),
      sub(SUB_A_TODAY, "recE2EEVA00000001", 2, "Pertemuan 2 - Sabda", wib(0)),
      sub("recE2ESUBA0000003", "recE2EEVA00000001", 3, "Pertemuan 3 - Penutup", wib(7)),
      sub("recE2ESUBB0000001", "recE2EEVA00000002", 1, "Pertemuan Tunggal", wib(0)),
      sub("recE2ESUBD0000001", "recE2EEVD00000001", 1, "Pertemuan D1", wib(10)),
      sub("recE2ESUBD0000002", "recE2EEVD00000001", 2, "Pertemuan D2", wib(17)),
      sub("recE2ESUBC0000001", "recE2EEVB00000001", 1, "Pertemuan Paroki Lain", wib(0)),
    ],
    [T.teamUmat]: [
      ...NAMES_A.map((n, i) => row(`recE2ETU00000000${i + 1}`, { [F.teamUmat.namaLengkap]: n })),
      row("recE2ETU00000000B1", { [F.teamUmat.namaLengkap]: "Yohanes Budi" }),
      row("recE2ETU00000000B2", { [F.teamUmat.namaLengkap]: "Zakaria Dewi" }),
      row("recE2ETU00000000C1", { [F.teamUmat.namaLengkap]: "Xaverius Lain" }),
    ],
    [T.pendaftaranEvents]: [
      ...NAMES_A.map((_, i) => pend(`recE2EPEND00000A${i + 1}`, "recE2EEVA00000001", `recE2ETU00000000${i + 1}`)),
      pend("recE2EPEND00000B1", "recE2EEVA00000002", "recE2ETU00000000B1"),
      pend("recE2EPEND00000B2", "recE2EEVA00000002", "recE2ETU00000000B2"),
      pend("recE2EPEND00000C1", "recE2EEVB00000001", "recE2ETU00000000C1"),
    ],
    [T.pengajarKep]: [
      row(PENGAJAR_1, { [F.pengajarKep.nama]: "Pewarta Satu", [F.pengajarKep.status]: "Aktif" }),
      row(PENGAJAR_2, { [F.pengajarKep.nama]: "Pewarta Dua", [F.pengajarKep.status]: "Aktif" }),
      row(PENGAJAR_OFF, { [F.pengajarKep.nama]: "Pewarta Pensiun", [F.pengajarKep.status]: "Tidak Aktif" }),
    ],
    [T.akunKep]: Object.values(ACC).map(acc),
    [T.auditKep]: [],
  };
}
