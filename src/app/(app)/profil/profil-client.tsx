"use client";

import { useState, type FormEvent } from "react";
import styles from "../forms.module.css";

type Json = Record<string, string>;
async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Json };
}

export default function ProfilClient({ google }: { google?: "ok" | "gagal" }) {
  const [msg, setMsg] = useState(
    google === "ok" ? "Akun Google terhubung." : google === "gagal" ? "Gagal menghubungkan Google. Pastikan alamat Google sama dengan email akun." : "",
  );
  const [reauth, setReauth] = useState("");
  const [enroll, setEnroll] = useState<{ qr: string; secret: string; pending: string } | null>(null);
  const [current, setCurrent] = useState("");
  const [code, setCode] = useState("");

  async function linkGoogle(e: FormEvent) {
    e.preventDefault();
    const r = await post("/api/auth/google/link", { code: reauth, password: reauth });
    if (r.ok && r.data.url) window.location.assign(r.data.url);
    else setMsg(r.data.error ?? "Gagal");
  }

  async function startEnroll(e: FormEvent) {
    e.preventDefault();
    const r = await post("/api/auth/mfa/manage", current ? { currentCode: current } : {});
    if (r.ok) setEnroll({ qr: r.data.qr, secret: r.data.secret, pending: r.data.pending });
    else setMsg(r.data.error ?? "Gagal");
  }

  async function finishEnroll(e: FormEvent) {
    e.preventDefault();
    const r = await post("/api/auth/mfa/manage", { pending: enroll?.pending, code, ...(current ? { currentCode: current, password: current } : {}) });
    setMsg(r.ok ? "Autentikator tersimpan." : r.data.error ?? "Gagal");
    if (r.ok) setEnroll(null);
  }

  return (
    <>
      {msg && <p role="status">{msg}</p>}
      <h2>Hubungkan Google</h2>
      <form className={styles.form} onSubmit={linkGoogle}>
        <input className={styles.input} autoComplete="one-time-code" placeholder="Kode autentikator (atau password untuk Admin tanpa MFA)" value={reauth} onChange={(e) => setReauth(e.target.value)} required />
        <button className={styles.button} type="submit">Hubungkan Google</button>
      </form>
      <h2>Autentikator (MFA)</h2>
      {!enroll ? (
        <form className={styles.form} onSubmit={startEnroll}>
          <input className={styles.input} placeholder="Kode saat ini (sudah terdaftar) atau password akun (pendaftaran pertama)" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <button className={styles.button} type="submit">Daftarkan / ganti autentikator</button>
        </form>
      ) : (
        <form className={styles.form} onSubmit={finishEnroll}>
          {/* eslint-disable-next-line @next/next/no-img-element -- server-rendered data URI, nothing to optimise */}
          <img className={styles.qr} src={enroll.qr} alt="Kode QR autentikator" />
          <p className={styles.secret}>{enroll.secret}</p>
          <input className={styles.input} inputMode="numeric" maxLength={6} placeholder="Kode 6 digit dari aplikasi baru" value={code} onChange={(e) => setCode(e.target.value)} required />
          <button className={styles.button} type="submit">Verifikasi</button>
        </form>
      )}
    </>
  );
}
