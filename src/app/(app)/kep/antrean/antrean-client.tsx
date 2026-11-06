"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../kep.module.css";

type Item = { id: string; nama: string; parokiNama: string; tanggalMulai: string; status: string; catatan: string };

export default function AntreanClient() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<{ items?: Item[]; error?: string }> => {
    try {
      const res = await fetch("/api/kep");
      const data = (await res.json().catch(() => ({}))) as { antrean?: Item[]; error?: string };
      return res.ok ? { items: data.antrean ?? [] } : { error: data.error ?? "Gagal memuat antrean" };
    } catch {
      return { error: "Tidak dapat terhubung. Coba lagi." };
    }
  }, []);
  const apply = useCallback((r: { items?: Item[]; error?: string }) => {
    if (r.items) setItems(r.items);
    else setMsg({ ok: false, text: r.error ?? "Gagal memuat antrean" });
  }, []);
  useEffect(() => {
    let live = true;
    load().then((r) => live && apply(r));
    return () => {
      live = false;
    };
  }, [load, apply]);

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
      const data = (await res.json().catch(() => ({}))) as { error?: string; emailTerkirim?: boolean };
      if (res.ok) {
        const warn = data.emailTerkirim === false ? " Email pemberitahuan gagal terkirim: mohon beri tahu PIC paroki secara manual." : "";
        setMsg({ ok: data.emailTerkirim !== false, text: `${it.nama}: ${keputusan}.${warn}` });
        apply(await load());
      } else setMsg({ ok: false, text: data.error ?? "Gagal menyimpan keputusan" });
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
