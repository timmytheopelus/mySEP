import { pageSession } from "@/lib/auth/page";
import ProfilClient from "./profil-client";
import styles from "../forms.module.css";

export const metadata = { title: "Profil - KEP Keuskupan Bandung" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await pageSession();
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
