"use client";

import { useState, type FormEvent } from "react";
import styles from "../kep.module.css";

export default function BaruClient() {
  const [angkatan, setAngkatan] = useState("");
  const [tanggal, setTanggal] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/kep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ angkatan: Number(angkatan), tanggalMulai: tanggal }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; subEventIds?: string[] };
      if (res.ok) {
        setMsg({ ok: true, text: `KEP diajukan dengan ${data.subEventIds?.length ?? 0} pertemuan. Menunggu persetujuan SEP.` });
        setAngkatan("");
        setTanggal("");
      } else setMsg({ ok: false, text: data.error ?? "Gagal mengajukan KEP" });
    } catch {
      setMsg({ ok: false, text: "Tidak dapat terhubung. Coba lagi." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.label}>
        Angkatan
        <input className={styles.input} type="number" inputMode="numeric" min={1} max={9999} step={1} required value={angkatan} onChange={(e) => setAngkatan(e.target.value)} />
      </label>
      <label className={styles.label}>
        Tanggal mulai
        <input className={styles.input} type="date" required value={tanggal} onChange={(e) => setTanggal(e.target.value)} />
        <span className={styles.hint}>Pertemuan pertama (Misa Pembukaan). Berikutnya setiap 7 hari.</span>
      </label>
      <button className={styles.button} type="submit" disabled={busy}>
        {busy ? "Mengirim..." : "Ajukan KEP"}
      </button>
      {msg && (
        <p className={msg.ok ? styles.ok : styles.error} role="status">
          {msg.text}
        </p>
      )}
    </form>
  );
}
