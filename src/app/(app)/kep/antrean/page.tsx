import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import AntreanClient from "./antrean-client";
import styles from "../kep.module.css";

export const metadata = { title: "Antrean persetujuan KEP - KEP Keuskupan Bandung" };

export default async function Page() {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  if (session.role !== "SEP") redirect("/");
  return (
    <main className={styles.main}>
      <h1>Antrean persetujuan KEP</h1>
      <AntreanClient />
    </main>
  );
}
