import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageSession } from "@/lib/auth/page";
import { HttpError } from "@/lib/http/errors";
import { getKesehatan, type Kesehatan } from "@/lib/kep/kesehatan";
import PrintButton from "./PrintButton";
import styles from "./kesehatan.module.css";

export const metadata = { title: "Data kesehatan peserta - KEP Keuskupan Bandung", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic"; // Cache-Control: no-store for this path is set in next.config.ts

/** PIC and Admin Paroki of the owning paroki only: SEP is sent back to the KEP page, another parish gets 404. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await pageSession();
  const { id } = await params;
  if (!/^rec[A-Za-z0-9]{10,}$/.test(id)) notFound();
  if (session.role !== "PIC" && session.role !== "ADMIN") redirect(`/kep/${id}`);

  let data: Kesehatan;
  try {
    data = await getKesehatan(session, id);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 404) notFound();
      if (e.status === 403) redirect(`/kep/${id}`);
    }
    throw e;
  }
  return (
    <main className={styles.page}>
      <div className={styles.noprint}>
        <Link prefetch={false} href={`/kep/${id}`} className={styles.back}>
          ← Kembali ke KEP
        </Link>
      </div>
      <h1 className={styles.title}>Data kesehatan peserta</h1>
      <p className={styles.meta}>
        {data.nama} · {data.items.length} dari {data.jumlahPeserta} peserta mencatat data kesehatan atau kontak darurat
      </p>
      <p className={styles.warn}>
        Data sensitif: hanya untuk PIC dan Admin paroki ini, untuk keperluan keselamatan peserta. Jangan dibagikan dan simpan cetakan di tempat aman. Setiap pembukaan halaman ini tercatat.
      </p>
      <div className={styles.noprint}>
        <PrintButton />
      </div>
      {data.items.length === 0 ? (
        <p className={styles.empty}>Belum ada peserta yang mencatat data kesehatan atau kontak darurat.</p>
      ) : (
        <ul className={styles.list} aria-label="Daftar peserta dengan data kesehatan">
          {data.items.map((p) => (
            <li key={p.pendaftaranId} className={`${styles.item} ${p.mundur ? styles.mundur : ""}`} data-testid="kesehatan-item">
              <h2 className={styles.nama}>
                {p.nama}
                {p.mundur ? <span className={styles.badge}> Mengundurkan diri</span> : null}
              </h2>
              <dl className={styles.dl}>
                {([
                  ["Riwayat penyakit", p.riwayatPenyakit],
                  ["Alergi", p.riwayatAlergi],
                  ["Obat rutin", p.obatRutin],
                  ["Kontak darurat", p.kontakDarurat],
                ] as [string, string][]).map(([label, v]) => (
                  <div key={label} className={styles.pair}>
                    <dt>{label}</dt>
                    <dd>{v || "-"}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
