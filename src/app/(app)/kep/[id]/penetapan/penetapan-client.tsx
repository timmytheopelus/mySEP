"use client";
import { useRef, useState } from "react";
import type { PenetapanSheet } from "@/lib/kep/absensi";
import styles from "./penetapan.module.css";

type Hasil = "LULUS" | "TIDAK LULUS";
type Row = PenetapanSheet["peserta"][number];
type St = "idle" | "saving" | "saved" | "error";

const newOpId = () => {
  try {
    return crypto.randomUUID().replaceAll("-", "");
  } catch {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  }
};
const tgl = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export default function PenetapanClient({ kepId, sheet }: { kepId: string; sheet: PenetapanSheet }) {
  const [rows, setRows] = useState<Row[]>(sheet.peserta);
  const [live, setLive] = useState("");
  const [st, setSt] = useState<Record<string, { s: St; msg?: string }>>({});
  // A failed network attempt keeps its opId so the retry is the same operation for the server.
  const ops = useRef(new Map<string, string>());

  const reason = sheet.terakhir
    ? sheet.terbuka
      ? null
      : `Hasil akhir baru bisa ditetapkan mulai pertemuan terakhir, ${tgl(sheet.terakhir)}.`
    : "Belum ada jadwal pertemuan, jadi hasil akhir belum bisa ditetapkan.";

  async function set(r: Row, hasil: Hasil) {
    if (reason || r.mundur || st[r.id]?.s === "saving") return;
    const key = `${r.id}:${hasil}`;
    const opId = ops.current.get(key) ?? newOpId();
    ops.current.set(key, opId);
    setSt((s) => ({ ...s, [r.id]: { s: "saving" } }));
    try {
      const res = await fetch(`/api/kep/${kepId}/peserta/${r.id}/penetapan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ hasil, opId }),
      });
      if (res.ok) {
        ops.current.delete(key);
        setRows((l) => l.map((x) => (x.id === r.id ? { ...x, hasil } : x)));
        setLive(`${r.nama}: ${hasil === "LULUS" ? "lulus" : "tidak lulus"} tersimpan`);
        return setSt((s) => ({ ...s, [r.id]: { s: "saved" } }));
      }
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      setLive(`${r.nama}: ${j?.error ?? "gagal menyimpan"}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 401) ops.current.delete(key);
      setSt((s) => ({ ...s, [r.id]: { s: "error", msg: j?.error ?? (res.status === 401 ? "Sesi berakhir. Masuk lagi." : "Gagal menyimpan. Coba lagi.") } }));
    } catch {
      setLive(`${r.nama}: tidak ada sinyal`);
      setSt((s) => ({ ...s, [r.id]: { s: "error", msg: "Tidak ada sinyal. Coba lagi." } }));
    }
  }

  return (
    <>
      <div role="status" aria-live="polite" className={styles.srOnly}>
        {live}
      </div>
      {reason && (
        <p className={styles.reason} data-testid="penetapan-alasan">
          {reason}
        </p>
      )}
      <ul className={styles.list}>
        {rows.map((r) => {
          const x = st[r.id];
          const off = !!reason || r.mundur;
          return (
            <li key={r.id} className={`${styles.row} ${r.mundur ? styles.mundur : ""}`} data-testid="penetapan-row">
              <span className={styles.nama}>
                {r.nama}
                {r.mundur && <span className={styles.badge}>Mengundurkan diri</span>}
              </span>
              <span className={styles.persen}>{r.persen === null ? "Kehadiran: -" : `Kehadiran: ${r.persen}%`}</span>
              <span className={styles.btns} role="group" aria-label={`Hasil akhir ${r.nama}`}>
                {(["LULUS", "TIDAK LULUS"] as const).map((h) => (
                  <button
                    key={h}
                    type="button"
                    className={`${styles.btn} ${r.hasil === h ? (h === "LULUS" ? styles.onLulus : styles.onTidak) : ""}`}
                    aria-pressed={r.hasil === h}
                    aria-disabled={off || x?.s === "saving" ? true : undefined}
                    onClick={() => void set(r, h)}
                  >
                    {h === "LULUS" ? "Lulus" : "Tidak lulus"}
                  </button>
                ))}
              </span>
              <span className={styles.stat} data-testid="penetapan-status">
                {x?.s === "saved" ? "tersimpan" : x?.s === "saving" ? "menyimpan…" : x?.s === "error" ? x.msg : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
