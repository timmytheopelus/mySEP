"use client";

import { useState } from "react";
import styles from "../pewarta.module.css";

export default function ProfilForm({ id, bio }: { id: string; bio: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, string> = { bioSingkat: String(fd.get("bio") ?? "") };
    const link = String(fd.get("link") ?? "").trim();
    if (link || fd.get("hapusLink")) body.linkYoutube = link;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/pewarta/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(res.ok ? { ok: true, text: "Profil disimpan. Muat ulang halaman untuk melihat hasilnya." } : { ok: false, text: data.error ?? "Gagal menyimpan profil." });
    } catch {
      setMsg({ ok: false, text: "Tidak dapat terhubung. Coba lagi." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Ubah profil pewarta">
      <label className={styles.label}>
        Bio singkat (teks biasa, maksimal 1000 karakter)
        <textarea className={styles.textarea} name="bio" defaultValue={bio} maxLength={1000} />
      </label>
      <label className={styles.label}>
        Tautan YouTube (https)
        <input className={styles.input} type="url" name="link" placeholder="https://youtu.be/..." maxLength={300} />
      </label>
      <label>
        <input type="checkbox" name="hapusLink" /> Hapus tautan YouTube yang ada
      </label>
      <button className={styles.button} type="submit" disabled={busy}>
        {busy ? "Menyimpan..." : "Simpan profil"}
      </button>
      {msg && (
        <p role="status" className={msg.ok ? styles.ok : styles.error}>
          {msg.text}
        </p>
      )}
    </form>
  );
}
