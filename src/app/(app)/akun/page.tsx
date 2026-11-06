import { redirect } from "next/navigation";
import { pageSession } from "@/lib/auth/page";
import AkunClient from "./akun-client";
import styles from "../forms.module.css";

export const metadata = { title: "Kelola akun - KEP Keuskupan Bandung" };

export default async function Page() {
  const session = await pageSession();
  if (session.role !== "SEP") redirect("/");
  return (
    <main className={styles.main}>
      <h1>Kelola akun</h1>
      <AkunClient />
    </main>
  );
}
