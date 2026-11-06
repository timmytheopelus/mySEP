"use client";

import { useEffect, useState, type FormEvent } from "react";
import styles from "../forms.module.css";

/** The one-time token travels in the URL fragment (never sent to servers or logs) and is wiped from the address bar. */
export default function Form() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token") ?? "";
    void Promise.resolve().then(() => setToken(t)); // after mount: the fragment is not available during SSR
    if (t) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/auth/reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (d.ok) setDone(true);
      else setMsg(d.error ?? "Gagal. Coba lagi.");
    } catch {
      setMsg("Terjadi kesalahan jaringan.");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p className={styles.ok} role="status">Password tersimpan. <a href="/login">Masuk</a></p>;
  if (!token) return <p className={styles.error} role="alert">Tautan tidak valid. Minta tautan baru lewat <a href="/lupa-password">lupa password</a>.</p>;
  return (
    <form className={styles.form} onSubmit={submit}>
      <input className={styles.input} type="password" autoComplete="new-password" placeholder="Password baru (min. 12 karakter)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required />
      {msg && <p className={styles.error} role="alert">{msg}</p>}
      <button className={styles.button} type="submit" disabled={busy}>Simpan password</button>
    </form>
  );
}
