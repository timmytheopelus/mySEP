"use client";

import { useState, type FormEvent } from "react";
import styles from "../forms.module.css";

export default function Form() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/auth/reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const d = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      setMsg(d.message ?? d.error ?? "Coba lagi nanti.");
    } catch {
      setMsg("Terjadi kesalahan jaringan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <input className={styles.input} type="email" autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <button className={styles.button} type="submit" disabled={busy}>Kirim tautan</button>
      {msg && <p role="status">{msg}</p>}
    </form>
  );
}
