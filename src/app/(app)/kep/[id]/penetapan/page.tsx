import type { ReactNode } from "react";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { HttpError } from "@/lib/http/errors";
import { getPenetapanSheet } from "@/lib/kep/absensi";
import PenetapanClient from "./penetapan-client";
import styles from "./penetapan.module.css";

export const metadata = { title: "Penetapan hasil akhir - KEP Keuskupan Bandung" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  if (session.role !== "PIC" && session.role !== "ADMIN") redirect("/");
  const { id } = await params;
  if (!/^rec[A-Za-z0-9]{10,}$/.test(id)) notFound();
  let sheet: Awaited<ReturnType<typeof getPenetapanSheet>>;
  try {
    sheet = await getPenetapanSheet(session, id);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 404) notFound();
      if (e.status === 403) redirect("/");
      if (e.status === 409) return <Shell id={id}><p>{e.message}</p></Shell>;
    }
    throw e;
  }
  return (
    <Shell id={id}>
      <PenetapanClient kepId={id} sheet={sheet} />
    </Shell>
  );
}

function Shell({ id, children }: { id: string; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <Link prefetch={false} href={`/kep/${id}`} className={styles.back}>
        ← Kembali ke KEP
      </Link>
      <h1>Penetapan hasil akhir</h1>
      {children}
    </main>
  );
}
