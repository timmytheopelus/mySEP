import Link from "next/link";
import styles from "../forms.module.css";

export const metadata = { title: "Terlalu banyak permintaan - KEP Keuskupan Bandung" };

/** Static: shown when an account spent its page/API read budget (no session check, no Airtable read). */
export default function BatasPage() {
  return (
    <main className={styles.main}>
      <h1>Terlalu banyak permintaan</h1>
      <p>Halaman dimuat terlalu sering dalam waktu singkat. Tunggu beberapa menit, lalu muat ulang.</p>
      <p>
        <Link href="/kep">Kembali ke daftar KEP</Link>
      </p>
    </main>
  );
}
