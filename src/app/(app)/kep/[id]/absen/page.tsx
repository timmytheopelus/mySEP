import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata, Viewport } from "next";
import { readSession, type Session } from "@/lib/auth/session";
import { HttpError } from "@/lib/http/errors";
import { getAbsenSheet, listPertemuan } from "@/lib/kep/absensi";
import AbsenClient from "./_components/AbsenClient";
import RegisterSw from "./_components/RegisterSw";
import styles from "./absen.module.css";

export const metadata: Metadata = { title: "Absen peserta - KEP Keuskupan Bandung", manifest: "/manifest.webmanifest" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b3d91" };

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ p?: string }> }) {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  if (session.role !== "PIC" && session.role !== "ADMIN") redirect("/");
  const { id } = await params;
  const { p } = await searchParams;
  if (!/^rec[A-Za-z0-9]{10,}$/.test(id)) notFound();

  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load(session, id, p);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 404) notFound();
      if (e.status === 403) redirect("/");
      if (e.status === 409) return <Message id={id} text={e.message} />;
    }
    throw e;
  }
  if (!data) return <Message id={id} text="Belum ada jadwal pertemuan untuk KEP ini." />;
  return (
    <>
      <RegisterSw />
      <AbsenClient key={`${id}:${data.chosen.id}`} kepId={id} owner={session.accountId} sub={data.chosen} pertemuan={data.items} today={data.today} initial={data.sheet} />
    </>
  );
}

function Message({ id, text }: { id: string; text: string }) {
  return (
    <main className={styles.page}>
      <Link prefetch={false} href={`/kep/${id}`} className={styles.back}>
        ← Kembali ke KEP
      </Link>
      <h1 className={styles.title}>Absen peserta</h1>
      <p className={styles.empty}>{text}</p>
    </main>
  );
}

async function load(session: Session, id: string, p?: string) {
  const { items, today } = await listPertemuan(session, id);
  // Default: today's meeting (WIB); else the next upcoming one; else the latest.
  const chosen = items.find((x) => x.id === p) ?? items.find((x) => x.tanggal === today) ?? items.find((x) => x.tanggal > today) ?? items.at(-1);
  if (!chosen) return null;
  const sheet = await getAbsenSheet(session, id, chosen.id);
  return { items: items.map(({ id: i, agenda, tanggal }) => ({ id: i, agenda, tanggal })), today, chosen, sheet };
}
