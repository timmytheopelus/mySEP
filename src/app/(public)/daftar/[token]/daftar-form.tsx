"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import styles from "./daftar.module.css";

type Paroki = { id: string; nama: string };
type Errors = Record<string, string>;
type Aria = { id: string; "aria-invalid"?: true; "aria-describedby"?: string };
declare global {
  interface Window {
    turnstile?: { reset: () => void };
  }
}

const HEALTH = ["riwayatPenyakit", "riwayatAlergi", "obatRutin"];

/** Label + control + hint + error, wired with aria-invalid / aria-describedby. `errKey` is the server's field path. */
function Field({ name, label, required, hint, errKey, errors, children }: {
  name: string; label: string; required?: boolean; hint?: string; errKey?: string; errors: Errors; children: (a: Aria) => ReactNode;
}) {
  const id = `f-${name}`;
  const msg = errors[errKey ?? name];
  const describedBy = [hint ? `${id}-hint` : "", msg ? `${id}-err` : ""].filter(Boolean).join(" ");
  return (
    <div className={styles.label}>
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children({ id, ...(msg ? { "aria-invalid": true as const } : {}), ...(describedBy ? { "aria-describedby": describedBy } : {}) })}
      {hint ? <span id={`${id}-hint`} className={styles.hint}>{hint}</span> : null}
      {msg ? <span id={`${id}-err`} className={styles.fieldError}>{msg}</span> : null}
    </div>
  );
}

export default function DaftarForm({ token, paroki, siteKey }: { token: string; paroki: Paroki[]; siteKey: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Errors>({});
  const [hasHealth, setHasHealth] = useState(false);
  const summary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) summary.current?.focus();
  }, [error, fields]);

  if (!siteKey)
    return (
      <p className={styles.error} role="alert">
        Formulir pendaftaran sedang tidak tersedia karena verifikasi keamanan belum diatur. Silakan hubungi panitia paroki Anda.
      </p>
    );

  function checkHealth(form: HTMLFormElement) {
    const fd = new FormData(form);
    setHasHealth(HEALTH.some((k) => String(fd.get(k) ?? "").trim() !== ""));
  }

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
          persetujuanKesehatan: v("persetujuanKesehatan") === "on",
          turnstileToken: v("cf-turnstile-response"),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { pesan?: string; error?: string; fields?: Errors };
      if (res.ok) {
        setDone(data.pesan ?? "Terima kasih, konfirmasi dikirim ke email Anda");
        return;
      }
      setError(data.error ?? "Pendaftaran gagal. Coba lagi.");
      setFields(data.fields ?? {});
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

  const list = Object.values(fields);
  return (
    <form className={styles.form} onSubmit={submit} onInput={(e) => checkHealth(e.currentTarget)}>
      <div ref={summary} tabIndex={-1} className={styles.summary} hidden={!error}>
        {error ? (
          <div role="alert">
            <p className={styles.error}>{error}</p>
            {list.length > 0 ? (
              <ul>
                {list.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <p className={styles.privacy}>
        Data kesehatan bersifat sukarela. Jika Anda mengisinya, data tersebut hanya dipakai panitia KEP paroki Anda untuk keselamatan peserta selama
        kegiatan, tidak ditampilkan kepada peserta lain dan tidak dikirim lewat email. Tanda * berarti wajib diisi.
      </p>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Data diri</legend>
        <Field name="namaLengkap" label="Nama lengkap" required errors={fields}>
          {(a) => <input {...a} className={styles.input} name="namaLengkap" type="text" autoComplete="name" required maxLength={100} />}
        </Field>
        <Field name="namaBaptis" label="Nama baptis (jika ada)" errors={fields}>
          {(a) => <input {...a} className={styles.input} name="namaBaptis" type="text" autoComplete="off" maxLength={100} />}
        </Field>
        <Field name="jenisKelamin" label="Jenis kelamin" required errors={fields}>
          {(a) => (
            <select {...a} className={styles.select} name="jenisKelamin" required defaultValue="">
              <option value="" disabled>Pilih</option>
              <option value="Pria">Pria</option>
              <option value="Wanita">Wanita</option>
            </select>
          )}
        </Field>
        <Field name="tanggalLahir" label="Tanggal lahir" required errors={fields}>
          {(a) => <input {...a} className={styles.input} name="tanggalLahir" type="date" autoComplete="bday" required />}
        </Field>
        <Field name="wa" label="Nomor WhatsApp" required hint="Nomor yang aktif di WhatsApp." errors={fields}>
          {(a) => <input {...a} className={styles.input} name="wa" type="tel" inputMode="tel" autoComplete="tel" required maxLength={40} placeholder="0812 3456 789" />}
        </Field>
        <Field name="email" label="Email" required hint="Konfirmasi pendaftaran dikirim ke email ini." errors={fields}>
          {(a) => <input {...a} className={styles.input} name="email" type="email" inputMode="email" autoComplete="email" required maxLength={254} />}
        </Field>
        <Field name="alamat" label="Alamat tinggal" required errors={fields}>
          {(a) => <textarea {...a} className={styles.textarea} name="alamat" autoComplete="street-address" required maxLength={300} />}
        </Field>
        <Field name="parokiAsalId" label="Paroki asal" required errors={fields}>
          {(a) => (
            <select {...a} className={styles.select} name="parokiAsalId" required defaultValue="">
              <option value="" disabled>Pilih paroki</option>
              {paroki.map((p) => (
                <option key={p.id} value={p.id}>{p.nama}</option>
              ))}
            </select>
          )}
        </Field>
        <Field name="statusPernikahan" label="Status pernikahan" required errors={fields}>
          {(a) => (
            <select {...a} className={styles.select} name="statusPernikahan" required defaultValue="">
              <option value="" disabled>Pilih</option>
              <option value="Single">Single</option>
              <option value="Menikah">Menikah</option>
              <option value="Tidak Menikah">Tidak Menikah</option>
            </select>
          )}
        </Field>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Kontak darurat</legend>
        <Field name="kontakDarurat" label="Nama dan nomor telepon" required errors={fields}>
          {(a) => <input {...a} className={styles.input} name="kontakDarurat" type="text" autoComplete="off" required maxLength={200} placeholder="Nama - 0812 ..." />}
        </Field>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Dua pendukung doa</legend>
        {[1, 2].map((n) => (
          <div key={n} className={styles.group}>
            <Field name={`doaNama${n}`} label={`Nama pendukung doa ${n}`} required errKey={`pendukungDoa.${n - 1}.nama`} errors={fields}>
              {(a) => <input {...a} className={styles.input} name={`doaNama${n}`} type="text" autoComplete="off" required maxLength={100} />}
            </Field>
            <Field name={`doaKontak${n}`} label={`Kontak pendukung doa ${n}`} required errKey={`pendukungDoa.${n - 1}.kontak`} errors={fields}>
              {(a) => <input {...a} className={styles.input} name={`doaKontak${n}`} type="tel" inputMode="tel" autoComplete="off" required maxLength={60} />}
            </Field>
          </div>
        ))}
        {fields.pendukungDoa ? <span className={styles.fieldError}>{fields.pendukungDoa}</span> : null}
      </fieldset>

      <details className={styles.details}>
        <summary className={styles.summaryToggle}>Data kesehatan (opsional)</summary>
        <div className={styles.fieldset}>
          <Field name="riwayatPenyakit" label="Riwayat penyakit" errors={fields}>
            {(a) => <textarea {...a} className={styles.textarea} name="riwayatPenyakit" maxLength={1000} />}
          </Field>
          <Field name="riwayatAlergi" label="Riwayat alergi" errors={fields}>
            {(a) => <textarea {...a} className={styles.textarea} name="riwayatAlergi" maxLength={1000} />}
          </Field>
          <Field name="obatRutin" label="Obat rutin yang dikonsumsi" errors={fields}>
            {(a) => <textarea {...a} className={styles.textarea} name="obatRutin" maxLength={1000} />}
          </Field>
          {hasHealth ? (
            <div className={styles.label}>
              <label className={styles.consent}>
                <input
                  id="f-persetujuanKesehatan"
                  className={styles.checkbox}
                  type="checkbox"
                  name="persetujuanKesehatan"
                  required
                  aria-invalid={fields.persetujuanKesehatan ? true : undefined}
                  aria-describedby={fields.persetujuanKesehatan ? "f-persetujuanKesehatan-err" : undefined}
                />
                <span>Saya setuju data kesehatan saya digunakan panitia KEP paroki untuk keselamatan peserta <span aria-hidden="true">*</span></span>
              </label>
              {fields.persetujuanKesehatan ? <span id="f-persetujuanKesehatan-err" className={styles.fieldError}>{fields.persetujuanKesehatan}</span> : null}
            </div>
          ) : null}
        </div>
      </details>

      <div className="cf-turnstile" data-sitekey={siteKey} data-language="id" />

      <button className={styles.button} type="submit" disabled={busy}>
        {busy ? "Mengirim..." : "Daftar"}
      </button>
    </form>
  );
}
