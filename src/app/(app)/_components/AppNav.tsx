"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { clearOfflineQueue } from "@/lib/offline/queue";
import styles from "./nav.module.css";

type Item = { href: string; label: string; match: (p: string) => boolean };

export default function AppNav({ sep }: { sep: boolean }) {
  const path = usePathname() ?? "";
  const [busy, setBusy] = useState(false);
  const items: Item[] = [
    { href: "/kep", label: "KEP", match: (p) => p === "/kep" || (p.startsWith("/kep/") && !p.startsWith("/kep/antrean")) },
    ...(sep ? [{ href: "/kep/antrean", label: "Antrean", match: (p: string) => p.startsWith("/kep/antrean") }] : []),
    { href: "/pewarta", label: "Pewarta", match: (p) => p.startsWith("/pewarta") },
    { href: sep ? "/akun" : "/profil", label: "Akun", match: (p) => p.startsWith("/akun") || p.startsWith("/profil") },
  ];

  async function logout() {
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
          <button type="button" className={styles.link} onClick={logout} disabled={busy}>
            {busy ? "Keluar..." : "Keluar"}
          </button>
        </li>
      </ul>
    </nav>
  );
}
