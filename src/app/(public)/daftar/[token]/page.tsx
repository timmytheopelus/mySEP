import { headers } from "next/headers";
import { listRecords } from "@/lib/airtable/client";
import { F, T } from "@/lib/airtable/schema";
import { clientIpFromHeaders } from "@/lib/http/auth-http";
import { RegistrationClosedError, resolveOpenKep, verifyRegistrationToken, verifyRegistrationTokenCurrent } from "@/lib/kep/registration";
import { limitKey, rateLimit } from "@/lib/ratelimit";
import DaftarForm from "./daftar-form";
import styles from "./daftar.module.css";

export const metadata = { title: "Pendaftaran KEP", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Every view costs Airtable reads (AuditKEP rotation lookup, KEP, paroki list) against the base-wide 5 req/s budget.
// Per IP, and per link (signature checked first, no I/O) so a link shared widely or replayed by a bot cannot drain it.
const VIEW_WINDOW_S = 600;
const VIEWS_PER_IP = 120;
const VIEWS_PER_LINK = 600;

async function allowed(token: string): Promise<boolean> {
  const ip = clientIpFromHeaders(await headers());
  if (!(await rateLimit(limitKey("daftar-view-ip", ip), VIEWS_PER_IP, VIEW_WINDOW_S)).ok) return false;
  const pre = verifyRegistrationToken(token);
  if (pre && !(await rateLimit(limitKey("daftar-view-kep", pre.eventId), VIEWS_PER_LINK, VIEW_WINDOW_S)).ok) return false;
  return true;
}

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
  if (!(await allowed(token))) {
    return (
      <main className={styles.main}>
        <h1>Terlalu banyak permintaan</h1>
        <p>Halaman ini sedang dibuka terlalu sering. Tunggu beberapa menit, lalu muat ulang.</p>
      </main>
    );
  }
  // Fail closed: if the rotation lookup (AuditKEP) or the KEP read fails, this throws and no form is shown.
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
