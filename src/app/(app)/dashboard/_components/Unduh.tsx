"use client";

import { useState } from "react";
import styles from "../dashboard.module.css";

export type UnduhLink = { href: string; label: string; filename: string };

/** A plain link (works without script), upgraded to fetch + save so an error body is shown in the page, never saved as a file. */
export function Unduh({ links }: { links: UnduhLink[] }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function go(e: React.MouseEvent, l: UnduhLink) {
    e.preventDefault();
    setErr(null);
    setBusy(l.href);
    try {
      const res = await fetch(l.href, { credentials: "same-origin" });
      if (!res.ok) {
        let m = "";
        try {
          m = ((await res.json()) as { error?: string }).error ?? "";
        } catch {
          /* not JSON */
        }
        setErr(m || (res.status === 429 ? "Terlalu sering mengunduh. Coba lagi sebentar lagi." : "Laporan belum dapat diunduh. Coba lagi."));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = l.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setErr("Laporan belum dapat diunduh. Periksa sambungan, lalu coba lagi.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <ul className={styles.links} aria-label="Unduh laporan (CSV)">
        {links.map((l) => (
          <li key={l.href}>
            <a className={styles.btn} href={l.href} download={l.filename} onClick={(e) => void go(e, l)} aria-busy={busy === l.href}>
              {l.label}
            </a>
          </li>
        ))}
      </ul>
      {err ? <p role="alert" className={styles.warn}>{err}</p> : null}
    </>
  );
}
