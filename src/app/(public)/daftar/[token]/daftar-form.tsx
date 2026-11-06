"use client";

import { useState, type FormEvent } from "react";
import styles from "./daftar.module.css";

type Paroki = { id: string; nama: string };
type Errors = Record<string, string>;
declare global {
  interface Window {
    turnstile?: { reset: () => void };
  }
}

export default function DaftarForm({ token, paroki, siteKey }: { token: string; paroki: Paroki[]; siteKey: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Errors>({});

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const v = (k: string) => String(fd.get(k) ?? "");
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const res = await fetch(`/api/daftar/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          namaLengkap: v("namaLengkap"),
          namaBaptis: v("namaBaptis"),
          jenisKelamin: v("jenisKelamin"),
          tanggalLahir: v("tanggalLahir"),
          wa: v("wa"),
          email: v("email"),
          alamat: v("alamat"),
          parokiAsalId: v("parokiAsalId"),
          statusPernikahan: v("statusPernikahan"),
          kontakDarurat: v("kontakDarurat"),
          pendukungDoa: [
            { nama: v("doaNama1"), kontak: v("doaKontak1") },
            { nama: v("doaNama2"), kontak: v("doaKontak2") },
          ],
          riwayatPenyakit: v("riwayatPenyakit"),
          riwayatAlergi: v("riwayatAlergi"),
          obatRutin: v("obatRutin"),
          turnstileToken: v("cf-turnstile-response"),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { pesan?: string; error?: string; fields?: Errors };
      if (res.ok) {
        setDone(data.pesan ?? "Terima kasih, konfirmasi dikirim ke email Anda");
        return;
      }
      setError(data.error ?? "Pendaftaran gagal. Coba lagi.");
      if (data.fields) setFields(data.fields);
      window.turnstile?.reset();
    } catch {
      setError("Tidak dapat terhubung. Periksa koneksi lalu coba lagi.");
      window.turnstile?.reset();
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <p className={styles.ok} role="status">
        {done}
      </p>
    );

  const err = (k: string) => (fields[k] ? <span className={styles.fieldError} role="alert">{fields[k]}</span> : null);

  return (
    <form className={styles.form} onSubmit={submit}>
      <p className={styles.privacy}>
        Data kesehatan (riwayat penyakit, alergi, obat rutin) hanya dipakai panitia dan tim medis KEP paroki Anda untuk menjaga keselamatan peserta selama
        kegiatan. Data ini tidak ditampilkan kepada peserta lain dan tidak dikirim lewat email. Mengisinya bersifat sukarela.
      </p>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Data diri</legend>
        <label className={styles.label}>
          Nama lengkap
          <input className={styles.input} name="namaLengkap" type="text" autoComplete="name" required maxLength={120} />
          {err("namaLengkap")}
        </label>
        <label className={styles.label}>
          Nama baptis (jika ada)
          <input className={styles.input} name="namaBaptis" type="text" autoComplete="off" maxLength={80} />
          {err("namaBaptis")}
        </label>
        <label className={styles.label}>
          Jenis kelamin
          <select className={styles.select} name="jenisKelamin" required defaultValue="">
            <option value="" disabled>Pilih</option>
            <option value="Pria">Pria</option>
            <option value="Wanita">Wanita</option>
          </select>
          {err("jenisKelamin")}
        </label>
        <label className={styles.label}>
          Tanggal lahir
          <input className={styles.input} name="tanggalLahir" type="date" autoComplete="bday" required />
          {err("tanggalLahir")}
        </label>
        <label className={styles.label}>
          Nomor WhatsApp
          <input className={styles.input} name="wa" type="tel" inputMode="tel" autoComplete="tel" required maxLength={40} placeholder="0812 3456 789" />
          <span className={styles.hint}>Nomor yang aktif di WhatsApp.</span>
          {err("wa")}
        </label>
        <label className={styles.label}>
          Email
          <input className={styles.input} name="email" type="email" inputMode="email" autoComplete="email" required maxLength={254} />
          <span className={styles.hint}>Konfirmasi pendaftaran dikirim ke alamat ini.</span>
          {err("email")}
        </label>
        <label className={styles.label}>
          Alamat tinggal
          <textarea className={styles.textarea} name="alamat" autoComplete="street-address" required maxLength={300} />
          {err("alamat")}
        </label>
        <label className={styles.label}>
          Paroki asal
          <select className={styles.select} name="parokiAsalId" required defaultValue="">
            <option value="" disabled>Pilih paroki</option>
            {paroki.map((p) => (
              <option key={p.id} value={p.id}>{p.nama}</option>
            ))}
          </select>
          {err("parokiAsalId")}
        </label>
        <label className={styles.label}>
          Status pernikahan
          <select className={styles.select} name="statusPernikahan" required defaultValue="">
            <option value="" disabled>Pilih</option>
            <option value="Single">Single</option>
            <option value="Menikah">Menikah</option>
            <option value="Tidak Menikah">Tidak Menikah</option>
          </select>
          {err("statusPernikahan")}
        </label>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Kontak darurat</legend>
        <label className={styles.label}>
          Nama dan nomor telepon
          <input className={styles.input} name="kontakDarurat" type="text" autoComplete="off" required maxLength={200} placeholder="Nama - 0812 ..." />
          {err("kontakDarurat")}
        </label>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Dua pendukung doa</legend>
        {[1, 2].map((n) => (
          <div key={n} className={styles.fieldset}>
            <label className={styles.label}>
              Nama pendukung doa {n}
              <input className={styles.input} name={`doaNama${n}`} type="text" autoComplete="off" required maxLength={100} />
              {err(`pendukungDoa.${n - 1}.nama`)}
            </label>
            <label className={styles.label}>
              Kontak pendukung doa {n}
              <input className={styles.input} name={`doaKontak${n}`} type="tel" inputMode="tel" autoComplete="off" required maxLength={60} />
              {err(`pendukungDoa.${n - 1}.kontak`)}
            </label>
          </div>
        ))}
        {err("pendukungDoa")}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Kesehatan (opsional)</legend>
        <label className={styles.label}>
          Riwayat penyakit
          <textarea className={styles.textarea} name="riwayatPenyakit" maxLength={1000} />
          {err("riwayatPenyakit")}
        </label>
        <label className={styles.label}>
          Riwayat alergi
          <textarea className={styles.textarea} name="riwayatAlergi" maxLength={1000} />
          {err("riwayatAlergi")}
        </label>
        <label className={styles.label}>
          Obat rutin yang dikonsumsi
          <textarea className={styles.textarea} name="obatRutin" maxLength={1000} />
          {err("obatRutin")}
        </label>
      </fieldset>

      {siteKey ? <div className="cf-turnstile" data-sitekey={siteKey} data-language="id" /> : null}

      <button className={styles.button} type="submit" disabled={busy}>
        {busy ? "Mengirim..." : "Daftar"}
      </button>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
