import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { HttpError } from "@/lib/http/errors";
import { getPewarta } from "@/lib/pewarta/profile";
import { embedUrl } from "@/lib/pewarta/youtube";
import ProfilForm from "./profil-form";
import styles from "../pewarta.module.css";

export const metadata = { title: "Profil pewarta - KEP Keuskupan Bandung" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await readSession((await cookies()).toString());
  if (!session) redirect("/login");
  const { id } = await params;
  let p;
  try {
    p = await getPewarta(session, id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  return (
    <main className={styles.main}>
      <Link className={styles.back} href="/pewarta">
        Kembali ke daftar pewarta
      </Link>
      <h1>{p.nama}</h1>
      {p.adaFoto && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.detailFoto} src={`/api/pewarta/${encodeURIComponent(p.id)}/foto`} alt={`Foto ${p.nama}`} width={144} height={144} />
      )}
      {p.babs.length > 0 && <p>Bab: {p.babs.join(", ")}</p>}
      {p.bio ? <p className={styles.bio}>{p.bio}</p> : <p className={styles.muted}>Belum ada bio singkat.</p>}
      {p.noHp && (
        <p>
          Nomor HP: <a href={`tel:${p.noHp.replace(/[^0-9+]/g, "")}`}>{p.noHp}</a>
        </p>
      )}
      {p.youtubeId && (
        <div className={styles.video}>
          <iframe
            className={styles.frame}
            src={embedUrl(p.youtubeId)}
            title={`Video perkenalan ${p.nama}`}
            loading="lazy"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
      )}
      {session.role === "SEP" && <ProfilForm id={p.id} bio={p.bio} />}
    </main>
  );
}
