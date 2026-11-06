import { redirect } from "next/navigation";
import { pageSession } from "@/lib/auth/page";
import AntreanClient from "./antrean-client";
import styles from "../kep.module.css";

export const metadata = { title: "Antrean persetujuan KEP - KEP Keuskupan Bandung" };

export default async function Page() {
  const session = await pageSession();
  if (session.role !== "SEP") redirect("/");
  return (
    <main className={styles.main}>
      <h1>Antrean persetujuan KEP</h1>
      <AntreanClient />
    </main>
  );
}
