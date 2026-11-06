"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { clearOfflineQueue, pendingOps } from "@/lib/offline/queue";
import styles from "./nav.module.css";

type Item = { href: string; label: string; match: (p: string) => boolean };

export default function AppNav({ sep, owner }: { sep: boolean; owner: string }) {
  const path = usePathname() ?? "";
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<number | null>(null); // unsent absen of this account: asks before they are discarded
  const stay = useRef<HTMLButtonElement>(null);
  const exitBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (pending !== null) stay.current?.focus();
  }, [pending]);
  const items: Item[] = [
    { href: "/kep", label: "KEP", match: (p) => p === "/kep" || (p.startsWith("/kep/") && !p.startsWith("/kep/antrean")) },
    ...(sep ? [{ href: "/kep/antrean", label: "Antrean", match: (p: string) => p.startsWith("/kep/antrean") }] : []),
    { href: "/pewarta", label: "Pewarta", match: (p) => p.startsWith("/pewarta") },
    { href: sep ? "/akun" : "/profil", label: "Akun", match: (p) => p.startsWith("/akun") || p.startsWith("/profil") },
  ];

  async function askLogout() {
    let n = 0;
    try {
      n = (await pendingOps(owner)).length;
    } catch {
      /* storage unavailable: nothing to lose */
    }
    if (n > 0) setPending(n);
    else await logout();
  }

  function cancelLogout() {
    setPending(null);
    exitBtn.current?.focus();
  }

  async function logout() {
    setPending(null);
    setBusy(true);
    // Antrean absen di perangkat ini dihapus DULU, sebelum sesi dicabut (perangkat bisa dipakai bergantian).
    try {
      await clearOfflineQueue();
    } catch {
      /* penyimpanan tidak tersedia: tetap keluar */
    }
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch {
      /* sesi tetap berakhir sendiri; lanjut ke halaman masuk */
    }
    window.location.replace("/login");
  }

  return (
    <nav className={styles.nav} aria-label="Menu utama">
      <ul className={styles.list}>
        {items.map((i) => (
          <li key={i.href}>
            <Link prefetch={false} href={i.href} className={styles.link} aria-current={i.match(path) ? "page" : undefined}>
              {i.label}
            </Link>
          </li>
        ))}
        <li className={styles.keluar}>
          <button ref={exitBtn} type="button" className={styles.link} onClick={askLogout} disabled={busy}>
            {busy ? "Keluar..." : "Keluar"}
          </button>
        </li>
      </ul>
      {pending !== null ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="keluar-judul"
          className={styles.dialog}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancelLogout();
          }}
        >
          <p id="keluar-judul" className={styles.dialogText}>
            {pending} absen belum terkirim akan hilang. Keluar sekarang?
          </p>
          <div className={styles.dialogActions}>
            <button ref={stay} type="button" className={styles.stay} onClick={cancelLogout}>
              Tetap di sini
            </button>
            <button type="button" className={styles.leave} onClick={logout}>
              Keluar sekarang
            </button>
          </div>
        </div>
      ) : null}
    </nav>
  );
}
