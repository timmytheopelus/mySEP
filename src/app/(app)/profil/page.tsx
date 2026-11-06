import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import ProfilClient from "./profil-client";
import styles from "../forms.module.css";

export const metadata = { title: "Profil - KEP Keuskupan Bandung" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  const q = await searchParams;
  const google = q.google === "ok" || q.google === "gagal" ? q.google : undefined;
  return (
    <main className={styles.main}>
      <h1>Profil</h1>
      <p>{session.email}</p>
      <ProfilClient google={google} />
    </main>
  );
}
