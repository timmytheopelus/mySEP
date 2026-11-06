"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import styles from "../hub.module.css";

type Paroki = { id: string; nama: string };
type Errors = Record<string, string>;
type Aria = { id: string; "aria-invalid"?: true; "aria-describedby"?: string };
const HEALTH = ["riwayatPenyakit", "riwayatAlergi", "obatRutin"];

/** Label + control + hint + error, wired with aria-invalid / aria-describedby. `errKey` is the server's field path. */
function Field({ name, label, required, hint, errKey, errors, children }: {
  name: string; label: string; required?: boolean; hint?: string; errKey?: string; errors: Errors; children: (a: Aria) => ReactNode;
}) {
  const id = `tp-${name}`;
  const msg = errors[errKey ?? name];
  const describedBy = [hint ? `${id}-hint` : "", msg ? `${id}-err` : ""].filter(Boolean).join(" ");
  return (
    <div className={styles.field}>
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

/**
 * Manual registration by PIC / Admin Paroki. Same fields and server rules as the public form (no captcha: the caller
 * is signed in). Health data needs the participant's consent, which the PIC records on their behalf (audited as such).
 */
export default function TambahPeserta({ kepId, paroki }: { kepId: string; paroki: Paroki[] }) {
  const router = useRouter();
  const panel = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Errors>({});
  const [hasHealth, setHasHealth] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) summary.current?.focus();
  }, [error, fields]);

  const checkHealth = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    setHasHealth(HEALTH.some((k) => String(fd.get(k) ?? "").trim() !== ""));
  };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const v = (k: string) => String(fd.get(k) ?? "");
    setBusy(true);
    setError(null);
    setDone(null);
    setFields({});
    try {
      const res = await fetch(`/api/kep/${kepId}/peserta`, {
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
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string; fields?: Errors };
      if (res.ok) {
        setDone(
          data.status === "already_registered"
            ? "Peserta ini sudah terdaftar di KEP ini. Tidak ada data yang diubah."
            : "Peserta didaftarkan. Email konfirmasi dikirim ke email yang tercatat.",
        );
        form.reset();
        setHasHealth(false);
        setDetailsOpen(false);
        router.refresh();
        return;
      }
      setError(data.error ?? "Pendaftaran gagal. Coba lagi.");
      setFields(data.fields ?? {});
    } catch {
      setError("Tidak dapat terhubung. Periksa koneksi lalu coba lagi.");
    } finally {
      setBusy(false);
    }
  }

  const list = Object.values(fields);
  const healthErr = HEALTH.concat("persetujuanKesehatan").some((k) => fields[k]);
  return (
    <section className={styles.card} aria-labelledby="h-tambah">
      <h2 id="h-tambah" className={styles.h2}>Tambah peserta</h2>
      <button type="button" className={styles.btn} aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
        {open ? "Tutup formulir" : "Tambah peserta (manual)"}
      </button>
      <div id={panel} hidden={!open} data-testid="tambah-peserta">
        <p role="status" className={styles.ok}>{done}</p>
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

          <p className={styles.note}>
            Jika orang ini sudah tercatat sebagai umat, konfirmasi dikirim ke email yang tercatat, bukan ke email yang Anda isi di sini. Data profil yang sudah
            ada tidak diubah lewat formulir ini; ubah profil di data umat. Tanda * berarti wajib diisi.
          </p>

          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>Data diri</legend>
            <Field name="namaLengkap" label="Nama lengkap" required errors={fields}>
              {(a) => <input {...a} className={styles.input} name="namaLengkap" type="text" autoComplete="off" required maxLength={100} />}
            </Field>
            <Field name="namaBaptis" label="Nama baptis (jika ada)" errors={fields}>
              {(a) => <input {...a} className={styles.input} name="namaBaptis" type="text" autoComplete="off" maxLength={100} />}
            </Field>
            <Field name="jenisKelamin" label="Jenis kelamin" required errors={fields}>
              {(a) => (
                <select {...a} className={styles.input} name="jenisKelamin" required defaultValue="">
                  <option value="" disabled>Pilih</option>
                  <option value="Pria">Pria</option>
                  <option value="Wanita">Wanita</option>
                </select>
              )}
            </Field>
            <Field name="tanggalLahir" label="Tanggal lahir" required errors={fields}>
              {(a) => <input {...a} className={styles.input} name="tanggalLahir" type="date" required />}
            </Field>
            <Field name="wa" label="Nomor WhatsApp" required hint="Nomor yang aktif di WhatsApp." errors={fields}>
              {(a) => <input {...a} className={styles.input} name="wa" type="tel" inputMode="tel" autoComplete="off" required maxLength={40} placeholder="0812 3456 789" />}
            </Field>
            <Field name="email" label="Email" required errors={fields}>
              {(a) => <input {...a} className={styles.input} name="email" type="email" inputMode="email" autoComplete="off" required maxLength={254} />}
            </Field>
            <Field name="alamat" label="Alamat tinggal" required errors={fields}>
              {(a) => <textarea {...a} className={styles.textarea} name="alamat" autoComplete="off" required maxLength={300} />}
            </Field>
            <Field name="parokiAsalId" label="Paroki asal" required errors={fields}>
              {(a) => (
                <select {...a} className={styles.input} name="parokiAsalId" required defaultValue="">
                  <option value="" disabled>Pilih paroki</option>
                  {paroki.map((p) => (
                    <option key={p.id} value={p.id}>{p.nama}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field name="statusPernikahan" label="Status pernikahan" required errors={fields}>
              {(a) => (
                <select {...a} className={styles.input} name="statusPernikahan" required defaultValue="">
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

          <details className={styles.details} open={detailsOpen || healthErr || undefined} onToggle={(e) => setDetailsOpen(e.currentTarget.open)}>
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
                <div className={styles.field}>
                  <label className={styles.consent}>
                    <input
                      id="tp-persetujuanKesehatan"
                      className={styles.checkbox}
                      type="checkbox"
                      name="persetujuanKesehatan"
                      required
                      aria-invalid={fields.persetujuanKesehatan ? true : undefined}
                      aria-describedby={fields.persetujuanKesehatan ? "tp-persetujuanKesehatan-err" : undefined}
                    />
                    <span>
                      Peserta telah menyetujui data kesehatannya digunakan panitia KEP paroki untuk keselamatan peserta. Saya mencatat persetujuan ini atas nama
                      peserta. <span aria-hidden="true">*</span>
                    </span>
                  </label>
                  {fields.persetujuanKesehatan ? <span id="tp-persetujuanKesehatan-err" className={styles.fieldError}>{fields.persetujuanKesehatan}</span> : null}
                </div>
              ) : null}
            </div>
          </details>

          <button className={styles.btnPrimary} type="submit" disabled={busy}>
            {busy ? "Mengirim..." : "Daftarkan peserta"}
          </button>
        </form>
      </div>
    </section>
  );
}
