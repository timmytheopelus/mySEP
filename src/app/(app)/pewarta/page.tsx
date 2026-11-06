import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { pengalamanPewarta } from "@/lib/pewarta/pengalaman";
import { filterPewarta, listPewarta } from "@/lib/pewarta/profile";
import styles from "./pewarta.module.css";

export const metadata = { title: "Pewarta - KEP Keuskupan Bandung" };
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 100) : "");

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  const sp = await searchParams;
  const q = { bab: one(sp.bab), nama: one(sp.nama) };
  const all = await listPewarta(session);
  const babs = [...new Set(all.flatMap((c) => c.babs))].sort();
  const shown = filterPewarta(all, q);
  // Aggregate only (count of KEP pertemuan per pewarta); the page still works without it.
  const pengalaman = await pengalamanPewarta(session).catch(() => new Map<string, number>());
  return (
    <main className={styles.main}>
      <h1>Pewarta</h1>
      <form method="get" className={styles.filter} role="search" aria-label="Cari pewarta">
        <label className={styles.label}>
          Nama
          <input className={styles.input} type="search" name="nama" defaultValue={q.nama} maxLength={100} />
        </label>
        <label className={styles.label}>
          Bab
          <select className={styles.input} name="bab" defaultValue={q.bab}>
            <option value="">Semua bab</option>
            {babs.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <button className={styles.button} type="submit">
          Cari
        </button>
      </form>
      {shown.length === 0 ? (
        <p className={styles.muted}>Tidak ada pewarta yang cocok.</p>
      ) : (
        <ul className={styles.grid}>
          {shown.map((c) => (
            <li key={c.id}>
              <Link className={styles.card} href={`/pewarta/${encodeURIComponent(c.id)}`}>
                {c.adaFoto ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className={styles.foto} src={`/api/pewarta/${encodeURIComponent(c.id)}/foto`} alt={`Foto ${c.nama}`} width={72} height={72} loading="lazy" />
                ) : (
                  <span className={styles.foto} role="img" aria-label={`${c.nama} belum memiliki foto`} />
                )}
                <span>
                  <h2 className={styles.nama}>{c.nama}</h2>
                  {c.babs.length > 0 && <p className={styles.meta}>{c.babs.join(", ")}</p>}
                  {(pengalaman.get(c.id) ?? 0) > 0 && <p className={styles.meta}>Mengajar di {pengalaman.get(c.id)} pertemuan KEP</p>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
