"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../kep.module.css";

type Item = { id: string; nama: string; parokiNama: string; tanggalMulai: string; status: string; catatan: string };

export default function AntreanClient() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/kep");
      const data = (await res.json().catch(() => ({}))) as { antrean?: Item[]; error?: string };
      if (res.ok) setItems(data.antrean ?? []);
      else setMsg({ ok: false, text: data.error ?? "Gagal memuat antrean" });
    } catch {
      setMsg({ ok: false, text: "Tidak dapat terhubung. Coba lagi." });
    }
  }, []);
  useEffect(() => {
    let live = true;
    fetch("/api/kep")
      .then(async (res) => ({ ok: res.ok, data: (await res.json().catch(() => ({}))) as { antrean?: Item[]; error?: string } }))
      .then((r) => {
        if (!live) return;
        if (r.ok) setItems(r.data.antrean ?? []);
        else setMsg({ ok: false, text: r.data.error ?? "Gagal memuat antrean" });
      })
      .catch(() => live && setMsg({ ok: false, text: "Tidak dapat terhubung. Coba lagi." }));
    return () => {
      live = false;
    };
  }, []);

  async function decide(it: Item, keputusan: "Disetujui" | "Ditolak") {
    const catatan = (notes[it.id] ?? "").trim();
    if ((keputusan === "Ditolak" || it.status === "Ditolak") && !catatan) {
      setMsg({ ok: false, text: "Catatan wajib diisi." });
      return;
    }
    setBusy(it.id);
    setMsg(null);
    try {
      const res = await fetch(`/api/kep/${encodeURIComponent(it.id)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keputusan, catatan }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(res.ok ? { ok: true, text: `${it.nama}: ${keputusan}.` } : { ok: false, text: data.error ?? "Gagal menyimpan keputusan" });
      if (res.ok) await load();
    } catch {
      setMsg({ ok: false, text: "Tidak dapat terhubung. Coba lagi." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {msg && (
        <p className={msg.ok ? styles.ok : styles.error} role="status">
          {msg.text}
        </p>
      )}
      {items === null && !msg && <p className={styles.muted}>Memuat...</p>}
      {items?.length === 0 && <p className={styles.muted}>Tidak ada pengajuan yang menunggu.</p>}
      <ul className={styles.list}>
        {items?.map((it) => (
          <li key={it.id} className={styles.card}>
            <h2 className={styles.title}>{it.nama}</h2>
            <p className={styles.meta}>
              Paroki {it.parokiNama}
              {it.tanggalMulai ? `, mulai ${it.tanggalMulai}` : ""} - {it.status}
            </p>
            {it.catatan && <p className={styles.meta}>Catatan SEP: {it.catatan}</p>}
            <label className={styles.label}>
              Catatan {it.status === "Ditolak" ? "(wajib untuk menyetujui kembali)" : "(wajib untuk menolak)"}
              <textarea className={styles.textarea} maxLength={2000} value={notes[it.id] ?? ""} onChange={(e) => setNotes({ ...notes, [it.id]: e.target.value })} />
            </label>
            <div className={styles.actions}>
              <button className={styles.button} disabled={busy === it.id} onClick={() => decide(it, "Disetujui")}>
                Setujui
              </button>
              {it.status === "Diajukan" && (
                <button className={styles.danger} disabled={busy === it.id} onClick={() => decide(it, "Ditolak")}>
                  Tolak
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
