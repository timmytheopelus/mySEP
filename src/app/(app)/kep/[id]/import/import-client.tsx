"use client";

import { useRef, useState, type FormEvent } from "react";
import styles from "../../kep.module.css";

type RowErr = { row: number; message: string };
type Preview = { valid: number; errors: RowErr[]; name: string };
type Result = { registered: number; alreadyRegistered: number; failed: number; failedRows: RowErr[]; ulang?: boolean };

export default function ImportClient({ kepId }: { kepId: string }) {
  const base = `/api/kep/${kepId}/import`;
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(kind: "preview" | "commit") {
    if (!file) return;
    setBusy(kind);
    setError(null);
    if (kind === "preview") {
      setPreview(null);
      setResult(null);
    }
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch(`${base}/${kind}`, { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
      if (!res.ok) setError(data.error ?? "Gagal memproses berkas");
      else if (kind === "preview") setPreview({ valid: data.valid as number, errors: data.errors as RowErr[], name: file.name });
      else {
        setResult(data as unknown as Result);
        setPreview(null);
      }
    } catch {
      setError("Tidak dapat terhubung. Coba lagi.");
    } finally {
      setBusy(null);
    }
  }

  function onPreview(e: FormEvent) {
    e.preventDefault();
    void send("preview");
  }

  return (
    <div className={styles.form}>
      <p>
        <a href={`${base}/template`} download>
          Unduh template Excel
        </a>
      </p>
      <form className={styles.form} onSubmit={onPreview}>
        <label className={styles.label}>
          Berkas Excel (.xlsx)
          <input
            ref={input}
            className={styles.input}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setResult(null);
              setError(null);
            }}
          />
          <span className={styles.hint}>Maksimal 2 MB dan 500 baris.</span>
        </label>
        <button className={styles.button} type="submit" disabled={!file || busy !== null}>
          {busy === "preview" ? "Memeriksa..." : "Periksa berkas"}
        </button>
      </form>

      <div aria-live="polite">
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {preview && (
          <section aria-label="Hasil pemeriksaan">
            <p className={preview.errors.length ? styles.warn : styles.ok}>
              {preview.valid} baris siap disimpan, {preview.errors.length} baris bermasalah.
            </p>
            {preview.errors.length > 0 && (
              <table>
                <caption>Baris bermasalah (tidak akan disimpan)</caption>
                <thead>
                  <tr>
                    <th scope="col">Baris</th>
                    <th scope="col">Masalah</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.errors.map((e) => (
                    <tr key={e.row}>
                      <td>{e.row}</td>
                      <td>{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <button className={styles.button} type="button" disabled={busy !== null || preview.valid === 0} onClick={() => void send("commit")}>
              {busy === "commit" ? "Menyimpan..." : `Simpan ${preview.valid} peserta`}
            </button>
          </section>
        )}
        {result && (
          <section aria-label="Hasil impor">
            <p className={result.failed ? styles.warn : styles.ok} role="status">
              {result.ulang ? "Berkas ini sudah pernah diimpor. " : ""}Terdaftar baru: {result.registered}. Sudah terdaftar sebelumnya: {result.alreadyRegistered}. Gagal: {result.failed}.
            </p>
            {result.failedRows.length > 0 && (
              <ul>
                {result.failedRows.map((e) => (
                  <li key={e.row}>
                    Baris {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
