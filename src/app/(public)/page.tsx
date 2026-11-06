import Link from "next/link";
import { publicStats, type PublicStats } from "@/lib/kep/readModel";
import {
  apaItuKep, bukuPegangan, buah, caraMengikuti, faq, hero, kesaksian, latarBelakang, materi, tujuan, untukSiapa,
} from "../../../content/landing";
import { testimonials, visibleTestimonials } from "../../../content/testimonials";
import Sebaran from "./_components/Sebaran";
import styles from "./landing.module.css";

export const metadata = {
  title: "Kursus Evangelisasi Pribadi (KEP) - Keuskupan Bandung",
  description: "KEP adalah kursus di paroki untuk umat yang ingin mewartakan Injil, dimulai dari diri sendiri.",
};

/** Statistik hanya agregat dan sudah di-cache di lib/kep; jika gagal, halaman tetap tampil tanpa angka (tanpa membocorkan galat). */
async function loadStats(): Promise<PublicStats | null> {
  try {
    return await publicStats();
  } catch {
    return null;
  }
}

export default async function LandingPage() {
  const stats = await loadStats();
  const kutipan = visibleTestimonials(testimonials);
  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <span className={styles.brand}>KEP Keuskupan Bandung</span>
        <Link href="/login" className={styles.masukKecil}>Masuk</Link>
      </header>

      <main id="isi">
        <section className={styles.hero} aria-labelledby="judul">
          <h1 id="judul" className={styles.judul}>{hero.judul}</h1>
          <p className={styles.lead}>{hero.lead}</p>
          <Link href="/login" className={styles.tombol}>Masuk</Link>
        </section>

        {stats && (
          <section className={styles.stats} aria-label="Angka ringkas KEP">
            <dl className={styles.statGrid}>
              <div data-testid="stat-paroki"><dt>Paroki</dt><dd>{stats.paroki}</dd></div>
              <div data-testid="stat-angkatan"><dt>Angkatan</dt><dd>{stats.angkatan}</dd></div>
              <div data-testid="stat-lulusan"><dt>Lulusan</dt><dd>{stats.lulusan}</dd></div>
            </dl>
          </section>
        )}

        <section className={styles.blok} aria-labelledby="apa">
          <h2 id="apa">{apaItuKep.judul}</h2>
          {apaItuKep.paragraf.map((p) => <p key={p}>{p}</p>)}
        </section>

        <section className={`${styles.blok} ${styles.gelap}`} aria-labelledby="tujuan">
          <h2 id="tujuan">{tujuan.judul}</h2>
          <ol className={styles.daftar}>
            {tujuan.butir.map((b) => <li key={b}>{b}</li>)}
          </ol>
        </section>

        <section className={styles.blok} aria-labelledby="siapa">
          <h2 id="siapa">{untukSiapa.judul}</h2>
          {untukSiapa.paragraf.map((p) => <p key={p}>{p}</p>)}
          <p className={styles.catatan}>{untukSiapa.catatan}</p>
        </section>

        <section className={`${styles.blok} ${styles.pink}`} aria-labelledby="cara">
          <h2 id="cara">{caraMengikuti.judul}</h2>
          <ol className={styles.langkah}>
            {caraMengikuti.langkah.map((l) => (
              <li key={l.judul}><strong>{l.judul}</strong><span>{l.isi}</span></li>
            ))}
          </ol>
        </section>

        <section className={styles.blok} aria-labelledby="materi">
          <h2 id="materi">{materi.judul}</h2>
          <ul className={styles.bab}>
            {materi.ringkas.map((r) => (
              <li key={r.angka}><span className={styles.angkaBab}>{r.angka}</span><span>{r.label}</span></li>
            ))}
          </ul>
          {materi.paragraf.map((p) => <p key={p}>{p}</p>)}
        </section>

        <section className={styles.blok} aria-labelledby="buku">
          <h2 id="buku">{bukuPegangan.judul}</h2>
          <ul className={styles.polos}>
            {bukuPegangan.daftar.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </section>

        <section className={`${styles.blok} ${styles.gelap}`} aria-labelledby="buah">
          <h2 id="buah">{buah.judul}</h2>
          <ul className={styles.polos}>
            {buah.butir.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </section>

        {kutipan.length > 0 && (
          <section className={styles.blok} aria-labelledby="kesaksian">
            <h2 id="kesaksian">{kesaksian.judul}</h2>
            {kutipan.map((k) => (
              <figure key={k.quote} className={styles.kutipan}>
                <blockquote>{k.quote}</blockquote>
                {k.name && (
                  <figcaption>
                    {k.photo && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={k.photo} alt="" width={48} height={48} />
                    )}
                    {k.name}
                  </figcaption>
                )}
              </figure>
            ))}
          </section>
        )}

        <section className={styles.blok} aria-labelledby="faq">
          <h2 id="faq">{faq.judul}</h2>
          {faq.item.map((f) => (
            <details key={f.tanya} className={styles.tanya}>
              <summary>{f.tanya}</summary>
              <p>{f.jawab}</p>
            </details>
          ))}
        </section>

        <Sebaran stats={stats} />

        <section className={styles.blok} aria-labelledby="latar">
          <h2 id="latar">{latarBelakang.judul}</h2>
          <p>{latarBelakang.paragraf}</p>
        </section>
      </main>

      <footer className={styles.kaki}>
        <span>Badan Pelayanan Keuskupan PDPKK Bandung</span>
        <Link href="/login" className={styles.tombol}>Masuk</Link>
      </footer>
    </div>
  );
}
