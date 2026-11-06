import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { HttpError } from "@/lib/http/errors";
import { kepDashboard, profilPeserta, rekapAngkatan, trenTahunan } from "@/lib/kep/reports";
import { ProfilBagian, Tabel, TrenChart } from "./_components/Charts";
import { Unduh } from "./_components/Unduh";
import styles from "./dashboard.module.css";

export const metadata = { title: "Dashboard paroki - KEP Keuskupan Bandung" };
export const dynamic = "force-dynamic";

/** PIC/ADMIN: only the own paroki (scope comes from the session, never from the URL). SEP goes to its own dashboard. */
export default async function Page() {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  if (session.role === "SEP") redirect("/dashboard/sep");
  if (!session.parokiId) {
    return (
      <main className={styles.main}>
        <h1>Dashboard</h1>
        <p role="alert" className={styles.warn}>Akun Anda belum terhubung ke paroki. Hubungi SEP untuk menghubungkan akun ke paroki.</p>
      </main>
    );
  }
  const scope = { parokiId: session.parokiId };
  let data;
  try {
    const [rekap, tren, profil, keps] = await Promise.all([rekapAngkatan(scope), trenTahunan(scope), profilPeserta(scope), kepDashboard(scope)]);
    data = { rekap, tren, profil, keps };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return (
      <main className={styles.main}>
        <h1>Dashboard paroki</h1>
        <p role="alert" className={styles.warn}>Data belum dapat dimuat. Coba lagi sebentar lagi.</p>
      </main>
    );
  }
  const { rekap, tren, profil, keps } = data;
  const sum = (f: (r: (typeof rekap)[number]) => number) => rekap.reduce((a, r) => a + f(r), 0);
  return (
    <main className={styles.main}>
      <h1>Dashboard paroki</h1>
      <ul className={styles.tiles}>
        <li className={styles.tile}><b>{keps.aktif}</b><span>KEP aktif</span></li>
        <li className={styles.tile}><b>{keps.disetujui}</b><span>KEP disetujui</span></li>
        <li className={styles.tile}><b>{rekap.length}</b><span>Angkatan tercatat</span></li>
        <li className={styles.tile}><b>{sum((r) => r.peserta)}</b><span>Peserta</span></li>
        <li className={styles.tile}><b>{sum((r) => r.lulus)}</b><span>Lulus</span></li>
      </ul>
      <Unduh
        links={[
          { href: "/api/laporan/rekap-angkatan?format=csv", label: "Unduh rekap angkatan", filename: "laporan-rekap-angkatan.csv" },
          { href: "/api/laporan/tren?format=csv", label: "Unduh tren tahunan", filename: "laporan-tren.csv" },
          { href: "/api/laporan/profil?format=csv", label: "Unduh profil peserta", filename: "laporan-profil.csv" },
        ]}
      />

      <h2>Riwayat angkatan</h2>
      <Tabel
        caption="Rekap per angkatan"
        rows={rekap}
        rowKey={(r) => `${r.paroki}-${r.angkatan}`}
        cols={[
          { head: "Angkatan", cell: (r) => (r.angkatan ? `Angkatan ${r.angkatan}` : "Tanpa nomor") },
          { head: "Peserta", cell: (r) => r.peserta },
          { head: "Lulus", cell: (r) => r.lulus },
          { head: "Tidak lulus", cell: (r) => r.tidakLulus },
          { head: "Mundur", cell: (r) => r.mundur },
        ]}
      />

      <h2>Tren tahunan</h2>
      {tren.length ? <TrenChart rows={tren} /> : null}
      <Tabel
        caption="Peserta dan lulusan per tahun"
        rows={tren}
        rowKey={(r) => String(r.tahun)}
        cols={[{ head: "Tahun", cell: (r) => r.tahun }, { head: "Angkatan", cell: (r) => r.angkatan }, { head: "Peserta", cell: (r) => r.peserta }, { head: "Lulus", cell: (r) => r.lulus }]}
      />

      <h2>Profil peserta</h2>
      <ProfilBagian profil={profil} />

      {keps.kehadiran.length ? (
        <>
          <h2>Kehadiran per pertemuan</h2>
          <Unduh links={keps.kehadiran.map((k) => ({ href: `/api/laporan/kehadiran?kep=${k.id}&format=csv`, label: `Kehadiran ${k.nama}`, filename: "laporan-kehadiran.csv" }))} />
        </>
      ) : null}
    </main>
  );
}
