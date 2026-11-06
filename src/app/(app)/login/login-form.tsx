"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import styles from "./login.module.css";

type Step = "credentials" | "mfa" | "enroll";
export type Initial = { step?: "mfa" | "enroll"; googleError?: boolean };

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, string> };
}

export default function LoginForm({ initial = {} }: { initial?: Initial }) {
  const router = useRouter();
  // Coming back from Google SSO: the Google callback already set the matching pre-auth cookie.
  const viaGoogle = initial.step !== undefined;
  const [step, setStep] = useState<Step>(initial.step ?? "credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [error, setError] = useState(initial.googleError ? "Login Google gagal. Gunakan akun yang terdaftar atau masuk dengan email dan password." : "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initial.step !== "enroll") return;
    post("/api/auth/mfa/enroll", {}).then((s) => {
      if (s.data.secret) {
        setSecret(s.data.secret);
        setQr(s.data.qr ?? "");
      }
      else setError(s.data.error ?? "Sesi habis. Silakan masuk kembali.");
    });
  }, [initial.step]);

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
      if (step === "mfa" && viaGoogle) {
        const r = await post("/api/auth/google/mfa", { code });
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
        setQr(s.data.qr ?? "");
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
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element -- server-rendered data URI, nothing to optimise
            <img className={styles.qr} src={qr} alt="Kode QR autentikator" />
          )}
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
      {step === "credentials" && (
        <>
          <a className={styles.google} href="/api/auth/google/start">Masuk dengan Google</a>
          <a href="/lupa-password">Lupa password?</a>
        </>
      )}
    </form>
  );
}
