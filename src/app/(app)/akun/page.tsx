import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import AkunClient from "./akun-client";
import styles from "../forms.module.css";

export const metadata = { title: "Kelola akun - KEP Keuskupan Bandung" };

export default async function Page() {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  if (session.role !== "SEP") redirect("/");
  return (
    <main className={styles.main}>
      <h1>Kelola akun</h1>
      <AkunClient />
    </main>
  );
}
