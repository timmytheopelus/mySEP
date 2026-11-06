import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { listRecords } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { readSession } from "@/lib/auth/session";
import { HttpError } from "@/lib/http/errors";
import { getKepHub, type KepHub } from "@/lib/kep/hub";
import { getLinkDaftar, type LinkDaftar } from "@/lib/kep/link";
import LinkDaftarCard from "./_components/LinkDaftar";
import TambahPeserta from "./_components/TambahPeserta";
import styles from "./hub.module.css";

export const metadata = { title: "Detail KEP - KEP Keuskupan Bandung" };
export const dynamic = "force-dynamic";

const tgl = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("id-ID", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }) : "-";

async function parokiOptions() {
  const rows = await listRecords(T.paroki, { fields: [F.paroki.nama] });
  return rows
    .map((p) => ({ id: p.id, nama: String(p.fields[F.paroki.nama] ?? "").trim() }))
    .filter((p) => p.nama)
    .sort((a, b) => a.nama.localeCompare(b.nama, "id"));
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  const { id } = await params;
  if (!/^rec[A-Za-z0-9]{10,}$/.test(id)) notFound();

  let hub: KepHub;
  try {
    hub = await getKepHub(session, id);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 404) notFound();
      if (e.status === 403) redirect("/");
    }
    throw e;
  }

  const disetujui = hub.status === "Disetujui";
  let link: LinkDaftar | null = null;
  let linkError: string | null = null;
  // Each optional card degrades on its own: an Airtable hiccup must not take the whole hub down.
  if (hub.pic && disetujui) {
    try {
      link = await getLinkDaftar(session, id);
    } catch (e) {
      linkError = e instanceof HttpError ? e.message : "Tautan belum dapat dimuat. Muat ulang halaman sebentar lagi.";
    }
  }
  let paroki: { id: string; nama: string }[] = [];
  let parokiError = false;
  if (hub.pic && disetujui) {
    try {
      paroki = await parokiOptions();
    } catch {
      parokiError = true;
    }
  }
  const today = hub.pertemuan.find((p) => p.id === hub.pertemuanBerikutnya);

  return (
    <main className={styles.page}>
      <Link prefetch={false} href="/kep" className={styles.back}>
        ← Semua KEP
      </Link>
      <header>
        <h1 className={styles.title}>{hub.nama}</h1>
        <p className={styles.meta}>
          {hub.angkatan ? `Angkatan ${hub.angkatan} · ` : ""}
          <span className={styles.badge} data-testid="kep-status">{hub.status || "Belum ada status"}</span>
        </p>
        <p className={styles.meta}>
          {tgl(hub.tanggalMulai)} sampai {tgl(hub.tanggalSelesai)}
        </p>
        {hub.status === "Diajukan" ? <p className={styles.meta}>Menunggu persetujuan SEP. Absen dan pendaftaran dibuka setelah disetujui.</p> : null}
        {hub.status === "Ditolak" ? <p className={styles.meta}>Pengajuan ini ditolak SEP.</p> : null}
      </header>

      <section className={styles.card} aria-labelledby="h-stat">
        <h2 id="h-stat" className={styles.h2}>Peserta</h2>
        <dl className={styles.stats}>
          <div className={styles.stat}><dt>Aktif</dt><dd data-testid="stat-aktif">{hub.statistik.aktif}</dd></div>
          <div className={styles.stat}><dt>Mundur</dt><dd data-testid="stat-mundur">{hub.statistik.mundur}</dd></div>
          <div className={styles.stat}><dt>Lulus</dt><dd data-testid="stat-lulus">{hub.statistik.lulus}</dd></div>
          <div className={styles.stat}><dt>Tidak lulus</dt><dd data-testid="stat-tidak-lulus">{hub.statistik.tidakLulus}</dd></div>
        </dl>
      </section>

      {hub.kelola ? (
        <nav className={styles.card} aria-label="Menu KEP">
          <h2 className={styles.h2}>Kelola</h2>
          <div className={styles.actions}>
            {hub.absenTersedia && hub.pertemuanBerikutnya ? (
              <Link prefetch={false} className={styles.btnPrimary} href={`/kep/${id}/absen?p=${hub.pertemuanBerikutnya}`}>
                Absen hari ini
              </Link>
            ) : null}
            {hub.absenTersedia ? (
              <Link prefetch={false} className={styles.linkBtn} href={`/kep/${id}/penetapan`}>
                Penetapan hasil akhir
              </Link>
            ) : null}
            {hub.pic && disetujui ? (
              <Link prefetch={false} className={styles.linkBtn} href={`/kep/${id}/import`}>
                Impor dari Excel
              </Link>
            ) : null}
            {hub.pic ? (
              <Link prefetch={false} className={styles.linkBtn} href={`/kep/${id}/jadwal`}>
                {hub.jadwalTerkunci ? "Lihat jadwal pewarta" : "Atur jadwal dan pewarta"}
              </Link>
            ) : null}
          </div>
          {hub.absenTersedia && today && !today.hariIni ? <p className={styles.hint}>Tidak ada pertemuan hari ini. Tombol Absen membuka pertemuan terdekat.</p> : null}
        </nav>
      ) : null}

      {hub.sepJadwal ? (
        <nav className={styles.card} aria-label="Menu SEP">
          <div className={styles.actions}>
            <Link prefetch={false} className={styles.linkBtn} href={`/kep/${id}/jadwal`}>
              Atur pewarta (SEP)
            </Link>
          </div>
        </nav>
      ) : null}

      <section className={styles.card} aria-labelledby="h-jadwal">
        <h2 id="h-jadwal" className={styles.h2}>Jadwal pertemuan ({hub.pertemuan.length})</h2>
        {hub.pic ? (
          <p className={styles.hint}>
            {hub.jadwalTerkunci
              ? "Penugasan pewarta terkunci setelah KEP disetujui SEP. Hubungi SEP jika perlu perubahan."
              : "Penugasan pewarta terbuka sampai KEP disetujui SEP, lalu terkunci."}
          </p>
        ) : null}
        {hub.pertemuan.length === 0 ? (
          <p className={styles.muted}>Belum ada pertemuan.</p>
        ) : (
          <ol className={styles.list}>
            {hub.pertemuan.map((p) => (
              <li key={p.id} className={`${styles.row} ${p.hariIni ? styles.rowToday : ""}`} data-testid="pertemuan-item">
                <span className={styles.rowTitle}>{p.agenda || `Pertemuan ${p.urutan}`}</span>
                <span className={styles.rowMeta}>
                  {tgl(p.tanggal || null)}
                  {p.hariIni ? " · Hari ini" : ""}
                </span>
                <span className={styles.rowMeta}>
                  {p.hadir} dari {p.aktif} hadir · {p.pengajarDitugaskan ? "Pewarta sudah ditugaskan" : "Pewarta belum ditugaskan"}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {hub.kelola ? (
        <>
          {hub.pic && link ? <LinkDaftarCard kepId={id} initial={link} /> : null}
          {linkError ? (
            <section className={styles.card} aria-labelledby="h-link-err" data-testid="tautan-daftar-error">
              <h2 id="h-link-err" className={styles.h2}>Tautan pendaftaran</h2>
              <p className={styles.error} role="alert">{linkError}</p>
            </section>
          ) : null}
          {hub.pic && !disetujui && hub.status !== "Ditolak" ? (
            <section className={styles.card}>
              <h2 className={styles.h2}>Tautan pendaftaran</h2>
              <p className={styles.muted}>Tautan pendaftaran dan input peserta tersedia setelah KEP disetujui SEP.</p>
            </section>
          ) : null}
          {hub.pic && disetujui && !parokiError ? <TambahPeserta kepId={id} paroki={paroki} /> : null}
          {hub.pic && disetujui && parokiError ? (
            <section className={styles.card}>
              <h2 className={styles.h2}>Tambah peserta</h2>
              <p className={styles.error} role="alert">Formulir belum dapat dimuat. Muat ulang halaman sebentar lagi.</p>
            </section>
          ) : null}

          <section className={styles.card} aria-labelledby="h-peserta">
            <h2 id="h-peserta" className={styles.h2}>Daftar peserta ({hub.peserta?.length ?? 0})</h2>
            {hub.peserta && hub.peserta.length > 0 ? (
              <ul className={styles.list}>
                {hub.peserta.map((p) => (
                  <li key={p.id} className={`${styles.peserta} ${p.status === "Aktif" ? "" : styles.pesertaMuted}`} data-testid="peserta-item">
                    <span>{p.nama}</span>
                    <span className={styles.badge}>{p.status}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.muted}>Belum ada peserta.</p>
            )}
          </section>
        </>
      ) : (
        <p className={styles.muted}>Tampilan hanya-baca: daftar nama dan data peserta dikelola oleh paroki penyelenggara.</p>
      )}
    </main>
  );
}
