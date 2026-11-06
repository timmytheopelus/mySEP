"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import styles from "../hub.module.css";

type Link = { url: string; qr: string; kadaluarsa: string; versi: number };

const opId = () => `rot-${crypto.randomUUID().replace(/-/g, "")}`;
const fmt = (iso: string) => new Date(iso).toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long", year: "numeric" });

export default function LinkDaftar({ kepId, initial }: { kepId: string; initial: Link }) {
  const [link, setLink] = useState(initial);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // Web Share exists only in some browsers; the server render and first client render both say "no".
  const canShare = useSyncExternalStore(
    () => () => undefined,
    () => typeof navigator.share === "function",
    () => false,
  );
  const input = useRef<HTMLInputElement>(null);
  const askBtn = useRef<HTMLButtonElement>(null);
  const yesBtn = useRef<HTMLButtonElement>(null);
  const rotateOp = useRef<string | null>(null);

  useEffect(() => {
    if (confirm) yesBtn.current?.focus();
  }, [confirm]);

  const say = (text: string, bad = false) => {
    setMsg(text);
    setErr(bad);
  };

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      say("Tautan disalin.");
    } catch {
      input.current?.select();
      say("Salin otomatis tidak tersedia. Tautan sudah terpilih: tahan lalu pilih Salin.", true);
    }
  }
  async function share() {
    try {
      await navigator.share({ title: "Pendaftaran KEP", url: link.url });
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") say("Tidak dapat membuka menu bagikan. Gunakan Salin tautan.", true);
    }
  }
  async function rotate() {
    setBusy(true);
    say("");
    rotateOp.current ??= opId(); // a retry after a network error reuses the id: the server rotates only once
    try {
      const r = await fetch(`/api/kep/${kepId}/link-daftar/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opId: rotateOp.current }),
      });
      if (!r.ok) return say(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Gagal membuat tautan baru.", true);
      rotateOp.current = null;
      const g = await fetch(`/api/kep/${kepId}/link-daftar`);
      if (!g.ok) return say("Tautan lama sudah dicabut, tetapi tautan baru belum dapat dimuat. Muat ulang halaman.", true);
      setLink((await g.json()) as Link);
      setConfirm(false);
      say("Tautan baru dibuat. Tautan lama tidak berlaku lagi.");
      requestAnimationFrame(() => askBtn.current?.focus());
    } catch {
      say("Tidak dapat terhubung. Coba lagi.", true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="h-link" data-testid="tautan-daftar">
      <h2 id="h-link" className={styles.h2}>Tautan pendaftaran</h2>
      <p className={styles.hint}>Bagikan ke calon peserta. Tautan berlaku sampai {fmt(link.kadaluarsa)} dan bisa dicabut kapan saja.</p>
      <label className={styles.field}>
        <span>Tautan pendaftaran</span>
        <input ref={input} className={styles.input} readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
      </label>
      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={copy}>Salin tautan</button>
        {canShare ? <button type="button" className={styles.btn} onClick={share}>Bagikan</button> : null}
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.qr} src={link.qr} alt="Kode QR tautan pendaftaran" width={240} height={240} />
      <p role="status" className={err ? styles.error : styles.ok}>{msg}</p>
      {confirm ? (
        <div id="link-konfirmasi" className={styles.warn} role="group" aria-label="Konfirmasi tautan baru">
          <p>Tautan yang sudah dibagikan akan berhenti berfungsi. Pendaftar harus memakai tautan baru. Lanjutkan?</p>
          <div className={styles.actions}>
            <button ref={yesBtn} type="button" className={styles.btnDanger} onClick={rotate} disabled={busy}>
              {busy ? "Memproses..." : "Ya, cabut tautan lama"}
            </button>
            <button type="button" className={styles.btn} onClick={() => setConfirm(false)} disabled={busy}>Batal</button>
          </div>
        </div>
      ) : (
        <button ref={askBtn} type="button" className={styles.btn} aria-expanded={false} aria-controls="link-konfirmasi" onClick={() => setConfirm(true)}>Buat tautan baru</button>
      )}
    </section>
  );
}
