"use client";

import { useRef, useState } from "react";
import styles from "./jadwal.module.css";

type Item = { id: string; urutan: number; agenda: string; tanggal: string; pengajarIds: string[] };
type Opsi = { id: string; nama: string };
type Msg = { text: string; bad: boolean };

const newOp = () => `peng-${crypto.randomUUID().replace(/-/g, "")}`;
const tgl = (iso: string) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("id-ID", { timeZone: "UTC", weekday: "short", day: "numeric", month: "long", year: "numeric" }) : "Tanggal belum diatur");
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export default function JadwalClient({ kepId, pertemuan, opsi }: { kepId: string; pertemuan: Item[]; opsi: Opsi[] }) {
  const aktif = new Set(opsi.map((o) => o.id));
  // Assigned but no longer active pewarta cannot be kept (the server only accepts active ones).
  const start = Object.fromEntries(pertemuan.map((p) => [p.id, p.pengajarIds.filter((i) => aktif.has(i))]));
  const hidden = Object.fromEntries(pertemuan.map((p) => [p.id, p.pengajarIds.filter((i) => !aktif.has(i)).length]));
  const [saved, setSaved] = useState<Record<string, string[]>>(start);
  const [sel, setSel] = useState<Record<string, string[]>>(start);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, Msg>>({});
  const ops = useRef<Record<string, string>>({}); // one opId per unsaved selection: a retry is idempotent, a new selection is a new op
  const nama = new Map(opsi.map((o) => [o.id, o.nama]));

  const toggle = (sid: string, pid: string, on: boolean) => {
    delete ops.current[sid];
    setMsg((m) => ({ ...m, [sid]: { text: "", bad: false } }));
    setSel((s) => ({ ...s, [sid]: on ? [...new Set([...(s[sid] ?? []), pid])] : (s[sid] ?? []).filter((x) => x !== pid) }));
  };

  async function save(sid: string) {
    const ids = sel[sid] ?? [];
    ops.current[sid] ??= newOp();
    setBusy(sid);
    setMsg((m) => ({ ...m, [sid]: { text: "Menyimpan...", bad: false } })); // shown at once; confirmed or corrected below
    try {
      const res = await fetch(`/api/kep/${kepId}/subevent/${sid}/pengajar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pengajarIds: ids, opId: ops.current[sid] }),
      });
      if (res.ok) {
        setSaved((s) => ({ ...s, [sid]: ids }));
        delete ops.current[sid];
        setMsg((m) => ({ ...m, [sid]: { text: "Tersimpan.", bad: false } }));
        return;
      }
      const err = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      setMsg((m) => ({ ...m, [sid]: { text: res.status === 401 ? "Sesi berakhir. Masuk lagi lalu simpan ulang." : (err ?? "Gagal menyimpan."), bad: true } }));
    } catch {
      setMsg((m) => ({ ...m, [sid]: { text: "Tidak dapat terhubung. Pilihan Anda masih di layar; coba simpan lagi.", bad: true } }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ol className={styles.list}>
      {pertemuan.map((p) => {
        const cur = saved[p.id] ?? [];
        const dirty = !same(cur, sel[p.id] ?? []) || (hidden[p.id] > 0 && msg[p.id]?.text !== "Tersimpan.");
        const m = msg[p.id];
        const isOpen = open === p.id;
        return (
          <li key={p.id} className={styles.row} data-testid="jadwal-item">
            <h2 className={styles.title}>{p.agenda || `Pertemuan ${p.urutan}`}</h2>
            <p className={styles.when}>{tgl(p.tanggal)}</p>
            <p className={styles.current}>
              Pewarta: {cur.length > 0 ? cur.map((i) => nama.get(i)).join(", ") : "belum ditugaskan"}
            </p>
            {hidden[p.id] > 0 && msg[p.id]?.text !== "Tersimpan." ? (
              <p className={styles.warn}>{hidden[p.id]} pewarta yang tercatat sudah tidak aktif dan akan dilepas saat disimpan.</p>
            ) : null}
            <div className={styles.actions}>
              <button type="button" className={styles.btn} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.id)}>
                {isOpen ? "Tutup pilihan" : "Ubah pewarta"}
              </button>
            </div>
            {isOpen ? (
              <fieldset className={styles.picker}>
                <legend className={styles.legend}>Pewarta untuk {p.agenda || `pertemuan ${p.urutan}`}</legend>
                {opsi.length === 0 ? <p>Belum ada pewarta aktif.</p> : null}
                {opsi.map((o) => (
                  <label key={o.id} className={styles.opt}>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={(sel[p.id] ?? []).includes(o.id)}
                      onChange={(e) => toggle(p.id, o.id, e.target.checked)}
                    />
                    <span>{o.nama}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <div className={styles.actions}>
              <button type="button" className={styles.btnPrimary} onClick={() => save(p.id)} disabled={busy === p.id || !dirty}>
                {busy === p.id ? "Menyimpan..." : "Simpan"}
              </button>
            </div>
            <p role="status" className={`${styles.msg} ${m?.bad ? styles.error : styles.ok}`}>{m?.text ?? ""}</p>
          </li>
        );
      })}
    </ol>
  );
}
