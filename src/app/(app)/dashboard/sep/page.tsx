import Link from "next/link";
import { redirect } from "next/navigation";
import { pageSession } from "@/lib/auth/page";
import { listKepQueue } from "@/lib/kep/approval";
import { profilPeserta, rekapAngkatan, trenTahunan } from "@/lib/kep/reports";
import { BarsH, ProfilBagian, Tabel, TrenChart } from "../_components/Charts";
import { Unduh } from "../_components/Unduh";
import styles from "../dashboard.module.css";

export const metadata = { title: "Dashboard SEP - KEP Keuskupan Bandung" };
export const dynamic = "force-dynamic";

/** SEP only: all parishes (incl. the 'Belum terpetakan' bucket), annual trend, approval queue, participant profile. */
export default async function Page() {
  const session = await pageSession();
  if (session.role !== "SEP") redirect("/dashboard");
  const all = { parokiId: "ALL" as const };
  let d;
  try {
    const [rekap, tren, profil, antrean] = await Promise.all([rekapAngkatan(all), trenTahunan(all), profilPeserta(all), listKepQueue(session)]);
    d = { rekap, tren, profil, antrean };
  } catch {
    return (
      <main className={styles.main}>
        <h1>Dashboard SEP</h1>
        <p role="alert" className={styles.warn}>Data belum dapat dimuat. Coba lagi sebentar lagi.</p>
      </main>
    );
  }
  const { rekap, tren, profil, antrean } = d;
  const per = new Map<string, { paroki: string; angkatan: number; peserta: number; lulus: number }>();
  for (const r of rekap) {
    const e = per.get(r.paroki) ?? { paroki: r.paroki, angkatan: 0, peserta: 0, lulus: 0 };
    e.angkatan += 1;
    e.peserta += r.peserta;
    e.lulus += r.lulus;
    per.set(r.paroki, e);
  }
  const sebaran = [...per.values()].sort((a, b) => b.peserta - a.peserta || a.paroki.localeCompare(b.paroki));
  const diajukan = antrean.filter((a) => a.status === "Diajukan").length;
  const ditolak = antrean.filter((a) => a.status === "Ditolak").length;
  return (
    <main className={styles.main}>
      <h1>Dashboard SEP</h1>
      <ul className={styles.tiles}>
        <li className={styles.tile}><b>{sebaran.filter((s) => s.paroki !== "Belum terpetakan").length}</b><span>Paroki</span></li>
        <li className={styles.tile}><b>{rekap.length}</b><span>Angkatan</span></li>
        <li className={styles.tile}><b>{rekap.reduce((a, r) => a + r.peserta, 0)}</b><span>Peserta</span></li>
        <li className={styles.tile}><b>{rekap.reduce((a, r) => a + r.lulus, 0)}</b><span>Lulus</span></li>
      </ul>
      <Unduh
        links={[
          { href: "/api/laporan/rekap-angkatan?format=csv", label: "Unduh rekap angkatan", filename: "laporan-rekap-angkatan.csv" },
          { href: "/api/laporan/tren?format=csv", label: "Unduh tren tahunan", filename: "laporan-tren.csv" },
          { href: "/api/laporan/profil?format=csv", label: "Unduh profil peserta", filename: "laporan-profil.csv" },
        ]}
      />

      <h2>Antrean persetujuan</h2>
      <p>
        <strong>{diajukan}</strong> menunggu keputusan, <strong>{ditolak}</strong> ditolak (masih dapat diubah).{" "}
        <Link prefetch={false} className={styles.btn} href="/kep/antrean">Buka antrean</Link>
      </p>

      <h2>Sebaran paroki</h2>
      <BarsH label="Peserta per paroki" items={sebaran.map((s) => ({ label: s.paroki, value: s.peserta }))} />
      <Tabel
        caption="Angkatan, peserta, dan lulusan per paroki"
        rows={sebaran}
        rowKey={(r) => r.paroki}
        cols={[{ head: "Paroki", cell: (r) => r.paroki }, { head: "Angkatan", cell: (r) => r.angkatan }, { head: "Peserta", cell: (r) => r.peserta }, { head: "Lulus", cell: (r) => r.lulus }]}
      />
      {per.has("Belum terpetakan") ? <p className={styles.muted}>&quot;Belum terpetakan&quot;: data lama yang belum dihubungkan ke paroki.</p> : null}

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
    </main>
  );
}
