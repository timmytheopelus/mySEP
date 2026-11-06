"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import styles from "../forms.module.css";

type Akun = { id: string; email: string; nama: string; role: string; parokiId: string | null; aktif: boolean; googleTerhubung: boolean; mfa: boolean };
type Paroki = { id: string; nama: string };

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export default function AkunClient() {
  const [akun, setAkun] = useState<Akun[]>([]);
  const [paroki, setParoki] = useState<Paroki[]>([]);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({ email: "", nama: "", role: "PIC", parokiId: "" });

  const load = useCallback(async () => {
    const r = await call("/api/akun", "GET");
    if (r.ok) {
      setAkun(r.data.akun as Akun[]);
      setParoki(r.data.paroki as Paroki[]);
    } else setMsg(String(r.data.error ?? "Gagal memuat"));
  }, []);
  useEffect(() => {
    let live = true;
    call("/api/akun", "GET").then((r) => {
      if (!live) return;
      if (r.ok) {
        setAkun(r.data.akun as Akun[]);
        setParoki(r.data.paroki as Paroki[]);
      } else setMsg(String(r.data.error ?? "Gagal memuat"));
    });
    return () => {
      live = false;
    };
  }, []);

  const parokiName = (id: string | null) => paroki.find((p) => p.id === id)?.nama ?? "-";

  async function create(e: FormEvent) {
    e.preventDefault();
    const r = await call("/api/akun", "POST", { ...form, parokiId: form.role === "SEP" ? null : form.parokiId });
    setMsg(r.ok ? (r.data.undanganTerkirim ? "Akun dibuat, undangan dikirim." : "Akun dibuat, tetapi email undangan gagal dikirim.") : String(r.data.error ?? "Gagal"));
    if (r.ok) setForm({ email: "", nama: "", role: "PIC", parokiId: "" });
    await load();
  }

  async function act(a: Akun, body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    const r = await call(`/api/akun/${encodeURIComponent(a.id)}`, "PATCH", body);
    setMsg(r.ok ? "Tersimpan." : String(r.data.error ?? "Gagal"));
    await load();
  }

  return (
    <>
      <form className={styles.form} onSubmit={create}>
        <input className={styles.input} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <input className={styles.input} placeholder="Nama" value={form.nama} onChange={(e) => setForm({ ...form, nama: e.target.value })} required />
        <select className={styles.select} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="PIC">PIC Paroki</option>
          <option value="ADMIN">Admin Paroki</option>
          <option value="SEP">SEP</option>
        </select>
        {form.role !== "SEP" && (
          <select className={styles.select} value={form.parokiId} onChange={(e) => setForm({ ...form, parokiId: e.target.value })} required>
            <option value="">Pilih paroki</option>
            {paroki.map((p) => <option key={p.id} value={p.id}>{p.nama}</option>)}
          </select>
        )}
        <button className={styles.button} type="submit">Buat akun dan kirim undangan</button>
      </form>
      {msg && <p role="status">{msg}</p>}
      <table className={styles.table}>
        <thead><tr><th>Email</th><th>Peran</th><th>Paroki</th><th>Status</th><th>Aksi</th></tr></thead>
        <tbody>
          {akun.map((a) => (
            <tr key={a.id}>
              <td>{a.email}<br /><span className={styles.muted}>{a.nama}</span></td>
              <td>{a.role}</td>
              <td>{parokiName(a.parokiId)}</td>
              <td>{a.aktif ? "Aktif" : "Nonaktif"}{a.googleTerhubung ? ", Google" : ""}{a.mfa ? ", MFA" : ""}</td>
              <td className={styles.actions}>
                {a.aktif ? (
                  <button className={styles.small} onClick={() => act(a, { action: "deactivate" }, `Nonaktifkan ${a.email}?`)}>Nonaktifkan</button>
                ) : (
                  <button className={styles.small} onClick={() => act(a, { action: "reactivate" }, `Aktifkan ${a.email}? Password diatur ulang lewat undangan baru.`)}>Aktifkan</button>
                )}
                {a.googleTerhubung && <button className={styles.small} onClick={() => act(a, { action: "clear_google" }, `Lepas akun Google ${a.email}?`)}>Lepas Google</button>}
                {a.mfa && <button className={styles.small} onClick={() => act(a, { action: "reset_mfa" }, `Reset MFA ${a.email}?`)}>Reset MFA</button>}
                <select className={styles.select} aria-label={`Ubah peran ${a.email}`} value="" onChange={(e) => {
                  const role = e.target.value;
                  if (!role) return;
                  let parokiId: string | null = null;
                  if (role !== "SEP") {
                    const nama = a.parokiId ? null : window.prompt("Nama paroki (persis seperti di daftar)");
                    parokiId = a.parokiId ?? paroki.find((p) => p.nama.toLowerCase() === (nama ?? "").trim().toLowerCase())?.id ?? null;
                    if (!parokiId) return void setMsg("Paroki tidak ditemukan.");
                  }
                  void act(a, { action: "set_role", role, parokiId }, `Ubah peran ${a.email} menjadi ${role}?`);
                }}>
                  <option value="">Ubah peran...</option>
                  <option value="SEP">SEP</option>
                  <option value="PIC">PIC Paroki</option>
                  <option value="ADMIN">Admin Paroki</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
