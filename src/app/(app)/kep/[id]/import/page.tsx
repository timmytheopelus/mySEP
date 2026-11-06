import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import ImportClient from "./import-client";
import styles from "../../kep.module.css";

export const metadata = { title: "Impor peserta dari Excel - KEP Keuskupan Bandung" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  if (session.role !== "PIC") redirect("/");
  const { id } = await params;
  if (!/^rec[A-Za-z0-9]{10,}$/.test(id)) notFound();
  return (
    <main className={styles.main}>
      <h1>Impor peserta dari Excel</h1>
      <p className={styles.meta}>
        Unduh template, isi data peserta (maksimal 100 baris per berkas, 2 MB, format .xlsx tanpa makro), lalu periksa hasilnya sebelum menyimpan. Pratinjau tidak menyimpan apa pun.
      </p>
      <ImportClient kepId={id} />
    </main>
  );
}
