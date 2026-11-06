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
  if (session.role !== "PIC" && session.role !== "SEP") redirect(`/kep/${id}`); // Admin Paroki reads the schedule on the detail page
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
      {jadwal.terkunci ? (
        <p className={styles.lock} data-testid="jadwal-terkunci">
          {session.role === "SEP" ? "KEP ini ditolak, sehingga penugasan pewarta tidak dapat diubah." : "Penugasan pewarta terkunci setelah KEP disetujui SEP; halaman ini hanya-baca. Hubungi SEP jika perlu perubahan."}
        </p>
      ) : (
        <p className={styles.hint}>
          Usulkan pewarta untuk tiap pertemuan, lalu simpan per pertemuan. Setelah KEP disetujui SEP, penugasan terkunci. Hanya pewarta yang aktif ditawarkan.
        </p>
      )}
      <JadwalClient kepId={id} pertemuan={jadwal.pertemuan} opsi={jadwal.opsi} terkunci={jadwal.terkunci} />
    </main>
  );
}
