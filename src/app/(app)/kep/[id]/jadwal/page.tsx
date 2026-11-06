import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageSession } from "@/lib/auth/page";
import { HttpError } from "@/lib/http/errors";
import { getJadwal, type Jadwal } from "@/lib/kep/jadwal";
import JadwalClient from "./jadwal-client";
import styles from "./jadwal.module.css";

export const metadata = { title: "Jadwal dan pewarta - KEP Keuskupan Bandung" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await pageSession();
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
      {jadwal.waktuTerkunci ? (
        <p className={styles.lock} data-testid="jadwal-terkunci">
          KEP ini ditolak, sehingga jadwal dan penugasan pewarta tidak dapat diubah.
        </p>
      ) : jadwal.terkunci ? (
        <p className={styles.lock} data-testid="jadwal-terkunci">
          Penugasan pewarta terkunci setelah KEP disetujui SEP; hubungi SEP jika perlu perubahan. Tanggal dan jam pertemuan masih dapat disesuaikan.
        </p>
      ) : (
        <p className={styles.hint}>
          Usulkan pewarta untuk tiap pertemuan dan sesuaikan tanggal atau jam bila perlu, lalu simpan per pertemuan. Setelah KEP disetujui SEP, penugasan pewarta terkunci (tanggal dan jam tetap dapat disesuaikan). Hanya pewarta yang aktif ditawarkan.
        </p>
      )}
      <JadwalClient kepId={id} pertemuan={jadwal.pertemuan} opsi={jadwal.opsi} terkunci={jadwal.terkunci} waktuTerkunci={jadwal.waktuTerkunci} mulai={jadwal.mulai} />
    </main>
  );
}
