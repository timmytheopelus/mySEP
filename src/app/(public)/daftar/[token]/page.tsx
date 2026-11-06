import { headers } from "next/headers";
import { listRecords } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { RegistrationClosedError, resolveOpenKep, verifyRegistrationTokenCurrent } from "@/lib/kep/registration";
import DaftarForm from "./daftar-form";
import styles from "./daftar.module.css";

export const metadata = { title: "Pendaftaran KEP", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function load(token: string): Promise<{ eventId: string; nama: string } | null> {
  const t = await verifyRegistrationTokenCurrent(token);
  if (!t) return null;
  try {
    const kep = await resolveOpenKep(t.eventId);
    return { eventId: kep.eventId, nama: kep.nama };
  } catch (e) {
    if (e instanceof RegistrationClosedError) return null;
    throw e;
  }
}

export default async function DaftarPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const kep = await load(token);
  if (!kep) {
    return (
      <main className={styles.main}>
        <h1>Pendaftaran tidak tersedia</h1>
        <p>Tautan pendaftaran ini tidak berlaku atau pendaftaran belum dibuka. Hubungi panitia paroki Anda.</p>
      </main>
    );
  }
  const paroki = (await listRecords(T.paroki, { fields: [F.paroki.nama] }))
    .map((p) => ({ id: p.id, nama: String(p.fields[F.paroki.nama] ?? "").trim() }))
    .filter((p) => p.nama)
    .sort((a, b) => a.nama.localeCompare(b.nama, "id"));
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const siteKey = process.env.TURNSTILE_SITE_KEY ?? "";
  return (
    <main className={styles.main}>
      <h1>Pendaftaran peserta</h1>
      <p className={styles.kep}>{kep.nama}</p>
      <DaftarForm token={token} paroki={paroki} siteKey={siteKey} />
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer nonce={nonce} />
    </main>
  );
}
