import Link from "next/link";
import { pageSession } from "@/lib/auth/page";
import { HttpError } from "@/lib/http/errors";
import { listKepIndex, type KepIndexItem } from "@/lib/kep/hub";
import styles from "./kep.module.css";

export const metadata = { title: "Daftar KEP - KEP Keuskupan Bandung" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await pageSession();
  let items: KepIndexItem[];
  try {
    items = await listKepIndex(session);
  } catch (e) {
    if (e instanceof HttpError && e.status === 403)
      return (
        <main className={styles.main}>
          <h1>KEP</h1>
          <p role="alert">Akun Anda belum terhubung ke paroki, sehingga daftar KEP belum dapat ditampilkan. Hubungi SEP untuk menghubungkan akun ke paroki.</p>
        </main>
      );
    throw e;
  }
  const sep = session.role === "SEP";
  return (
    <main className={styles.main}>
      <h1>{sep ? "Semua KEP" : "KEP paroki Anda"}</h1>
      {session.role === "PIC" ? (
        <p>
          <Link prefetch={false} className={styles.linkAction} href="/kep/baru">
            Ajukan KEP baru
          </Link>
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className={styles.muted}>Belum ada KEP.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((k) => (
            <li key={k.id}>
              <Link prefetch={false} className={styles.card} href={`/kep/${k.id}`} data-testid="kep-item">
                <span className={styles.title}>{k.nama}</span>
                <span className={styles.meta}>
                  {k.angkatan ? `Angkatan ${k.angkatan} · ` : ""}
                  {k.status || "Belum ada status"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
