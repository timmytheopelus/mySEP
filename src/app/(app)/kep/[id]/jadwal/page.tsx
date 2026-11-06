import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { HttpError } from "@/lib/http/errors";
import { getJadwal, type Jadwal } from "@/lib/kep/jadwal";
import JadwalClient from "./jadwal-client";
import styles from "./jadwal.module.css";

export const metadata = { title: "Jadwal dan pewarta - KEP Keuskupan Bandung" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  const { id } = await params;
  if (!/^rec[A-Za-z0-9]{10,}$/.test(id)) notFound();
  if (session.role === "SEP") redirect(`/kep/${id}`); // SEP reads the schedule on the detail page; assignment is the paroki's job
  let jadwal: Jadwal;
  try {
    jadwal = await getJadwal(session, id);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 404) notFound();
      if (e.status === 403) redirect("/");
      if (e.status === 409)
        return (
          <main className={styles.page}>
            <Link prefetch={false} href={`/kep/${id}`} className={styles.back}>← Kembali ke KEP</Link>
            <h1>Jadwal dan pewarta</h1>
            <p>{e.message}</p>
          </main>
        );
    }
    throw e;
  }
  return (
    <main className={styles.page}>
      <Link prefetch={false} href={`/kep/${id}`} className={styles.back}>
        ← Kembali ke KEP
      </Link>
      <h1>Jadwal dan pewarta</h1>
      <p className={styles.hint}>Pilih pewarta untuk tiap pertemuan, lalu simpan per pertemuan. Hanya pewarta yang aktif ditawarkan.</p>
      <JadwalClient kepId={id} pertemuan={jadwal.pertemuan} opsi={jadwal.opsi} />
    </main>
  );
}
