"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import styles from "./login.module.css";

type Step = "credentials" | "mfa" | "enroll";

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, string> };
}

export default function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (step === "enroll") {
        const r = await post("/api/auth/mfa/enroll", { code });
        if (r.data.ok) return void router.replace("/");
        setError(r.data.error ?? "Gagal");
        return;
      }
      const r = await post("/api/auth/login", { email, password, ...(step === "mfa" ? { totp: code } : {}) });
      if (r.data.ok) return void router.replace("/");
      if (r.data.next === "mfa") return void (setStep("mfa"), setCode(""));
      if (r.data.next === "mfa_enroll") {
        const s = await post("/api/auth/mfa/enroll", {});
        setSecret(s.data.secret ?? "");
        setCode("");
        return void setStep("enroll");
      }
      setError(r.data.error ?? "Gagal");
    } catch {
      setError("Terjadi kesalahan jaringan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {step === "credentials" && (
        <>
          <input className={styles.input} type="email" autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className={styles.input} type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </>
      )}
      {step === "enroll" && (
        <>
          <p>Pindai kode ini di aplikasi autentikator, atau masukkan kunci berikut:</p>
          <p className={styles.secret}>{secret}</p>
        </>
      )}
      {step !== "credentials" && (
        <input className={styles.input} inputMode="numeric" autoComplete="one-time-code" placeholder="Kode 6 digit" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} required />
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.button} type="submit" disabled={busy}>
        {step === "credentials" ? "Masuk" : "Verifikasi"}
      </button>
    </form>
  );
}
