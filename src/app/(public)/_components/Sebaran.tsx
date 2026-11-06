import type { PublicStats } from "@/lib/kep/readModel";
import { sebaran } from "../../../../content/landing";
import styles from "../landing.module.css";

export default function Sebaran({ stats }: { stats: PublicStats | null }) {
  return (
    <section className={`${styles.blok} ${styles.pink}`} aria-labelledby="sebaran">
      <h2 id="sebaran">{sebaran.judul}</h2>
      {stats && stats.daftarParoki.length > 0 ? (
        <ul className={styles.paroki} data-testid="daftar-paroki">
          {stats.daftarParoki.map((p) => (
            <li key={p.nama}>
              <span>{p.nama}</span>
              <span className={styles.chip}>Angkatan {p.angkatan}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>Daftar paroki belum dapat ditampilkan saat ini. Silakan kembali beberapa saat lagi.</p>
      )}
    </section>
  );
}
