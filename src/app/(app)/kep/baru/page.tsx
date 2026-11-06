import { redirect } from "next/navigation";
import { pageSession } from "@/lib/auth/page";
import BaruClient from "./baru-client";
import styles from "../kep.module.css";

export const metadata = { title: "Ajukan KEP baru - KEP Keuskupan Bandung" };

export default async function Page() {
  const session = await pageSession();
  if (session.role !== "PIC") redirect("/");
  return (
    <main className={styles.main}>
      <h1>Ajukan KEP baru</h1>
      <p className={styles.meta}>
        Jadwal 28 pertemuan dibuat otomatis, mingguan sejak tanggal mulai. KEP berstatus &quot;Diajukan&quot; sampai disetujui SEP.
      </p>
      <BaruClient />
    </main>
  );
}
