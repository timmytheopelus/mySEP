"use client";

import { useRef, useState } from "react";
import styles from "./jadwal.module.css";

type Item = { id: string; urutan: number; agenda: string; tanggal: string; jamMulai: string; jamSelesai: string; pengajarIds: string[] };
type Waktu = { tanggal: string; jamMulai: string; jamSelesai: string };
type Opsi = { id: string; nama: string };
type Msg = { text: string; bad: boolean };

const newOp = () => `peng-${crypto.randomUUID().replace(/-/g, "")}`;
const newWaktuOp = () => `jdw-${crypto.randomUUID().replace(/-/g, "")}`;
const plusYear = (iso: string) => (iso ? `${Number(iso.slice(0, 4)) + 1}${iso.slice(4)}` : "");
const tgl = (iso: string) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("id-ID", { timeZone: "UTC", weekday: "short", day: "numeric", month: "long", year: "numeric" }) : "Tanggal belum diatur");
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export default function JadwalClient({
  kepId,
  pertemuan,
  opsi,
  terkunci,
  waktuTerkunci,
  mulai,
}: {
  kepId: string;
  pertemuan: Item[];
  opsi: Opsi[];
  terkunci: boolean;
  waktuTerkunci: boolean;
  mulai: string;
}) {
  const aktif = new Set(opsi.map((o) => o.id));
  // Assigned but no longer active pewarta cannot be kept (the server only accepts active ones).
  const start = Object.fromEntries(pertemuan.map((p) => [p.id, p.pengajarIds.filter((i) => aktif.has(i))]));
  const hidden = Object.fromEntries(pertemuan.map((p) => [p.id, p.pengajarIds.filter((i) => !aktif.has(i)).length]));
  const [saved, setSaved] = useState<Record<string, string[]>>(start);
  const [sel, setSel] = useState<Record<string, string[]>>(start);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<Record<string, Msg>>({});
  const ops = useRef<Record<string, string>>({}); // one opId per unsaved selection: a retry is idempotent, a new selection is a new op
  const nama = new Map(opsi.map((o) => [o.id, o.nama]));

  // ---- tanggal / jam (one save per row) ----
  const w0 = Object.fromEntries(pertemuan.map((p) => [p.id, { tanggal: p.tanggal, jamMulai: p.jamMulai, jamSelesai: p.jamSelesai }])) as Record<string, Waktu>;
  const [savedW, setSavedW] = useState<Record<string, Waktu>>(w0);
  const [draftW, setDraftW] = useState<Record<string, Waktu>>(w0);
  const [busyW, setBusyW] = useState<Record<string, boolean>>({});
  const [msgW, setMsgW] = useState<Record<string, Msg>>({});
  const opsW = useRef<Record<string, string>>({});
  const editW = (sid: string, k: keyof Waktu, v: string) => {
    delete opsW.current[sid]; // a changed value is a new operation
    setMsgW((m) => ({ ...m, [sid]: { text: "", bad: false } }));
    setDraftW((d) => ({ ...d, [sid]: { ...d[sid], [k]: v } }));
  };
  const invalidW = (w: Waktu): string | null => {
    if (!w.tanggal) return "Isi tanggal.";
    if (mulai && w.tanggal < mulai) return "Tanggal tidak boleh sebelum tanggal mulai KEP.";
    if (mulai && w.tanggal > plusYear(mulai)) return "Tanggal terlalu jauh (maksimal satu tahun setelah tanggal mulai KEP).";
    if ((w.jamMulai === "") !== (w.jamSelesai === "")) return "Isi jam mulai dan jam selesai, atau kosongkan keduanya.";
    if (w.jamMulai && w.jamSelesai <= w.jamMulai) return "Jam selesai harus setelah jam mulai.";
    return null;
  };

  async function saveWaktu(sid: string) {
    const want = draftW[sid];
    const before = savedW[sid];
    const bad = invalidW(want);
    if (bad) return setMsgW((m) => ({ ...m, [sid]: { text: bad, bad: true } }));
    opsW.current[sid] ??= newWaktuOp();
    setBusyW((b) => ({ ...b, [sid]: true }));
    setSavedW((s) => ({ ...s, [sid]: want })); // optimistic: the heading shows the new date at once, rolled back on failure
    setMsgW((m) => ({ ...m, [sid]: { text: "Tersimpan.", bad: false } }));
    try {
      const res = await fetch(`/api/kep/${kepId}/subevent/${sid}/jadwal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...want, opId: opsW.current[sid] }),
      });
      if (res.ok) {
        const back = (await res.json().catch(() => null)) as Partial<Waktu> | null;
        const confirmed: Waktu = { tanggal: back?.tanggal ?? want.tanggal, jamMulai: back?.jamMulai ?? want.jamMulai, jamSelesai: back?.jamSelesai ?? want.jamSelesai };
        setSavedW((s) => ({ ...s, [sid]: confirmed }));
        setDraftW((d) => ({ ...d, [sid]: confirmed }));
        delete opsW.current[sid];
        return;
      }
      const err = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      setSavedW((s) => ({ ...s, [sid]: before }));
      setMsgW((m) => ({ ...m, [sid]: { text: res.status === 401 ? "Sesi berakhir. Masuk lagi lalu simpan ulang." : (err ?? "Gagal menyimpan."), bad: true } }));
    } catch {
      setSavedW((s) => ({ ...s, [sid]: before }));
      setMsgW((m) => ({ ...m, [sid]: { text: "Tidak dapat terhubung. Isian Anda masih di layar; coba simpan lagi.", bad: true } }));
    } finally {
      setBusyW((b) => ({ ...b, [sid]: false }));
    }
  }

  const toggle = (sid: string, pid: string, on: boolean) => {
    delete ops.current[sid];
    setMsg((m) => ({ ...m, [sid]: { text: "", bad: false } }));
    setSel((s) => ({ ...s, [sid]: on ? [...new Set([...(s[sid] ?? []), pid])] : (s[sid] ?? []).filter((x) => x !== pid) }));
  };

  async function save(sid: string) {
    const ids = sel[sid] ?? [];
    ops.current[sid] ??= newOp();
    setBusy((b) => ({ ...b, [sid]: true }));
    setMsg((m) => ({ ...m, [sid]: { text: "Menyimpan...", bad: false } })); // shown at once; confirmed or corrected below
    try {
      const res = await fetch(`/api/kep/${kepId}/subevent/${sid}/pengajar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pengajarIds: ids, opId: ops.current[sid] }),
      });
      if (res.ok) {
        // The server's answer is the truth (it dedupes and may differ from what was sent).
        const back = ((await res.json().catch(() => null)) as { pengajarIds?: unknown } | null)?.pengajarIds;
        const confirmed = Array.isArray(back) ? back.filter((x): x is string => typeof x === "string") : ids;
        setSaved((s) => ({ ...s, [sid]: confirmed }));
        setSel((s) => ({ ...s, [sid]: confirmed }));
        delete ops.current[sid];
        setMsg((m) => ({ ...m, [sid]: { text: "Tersimpan.", bad: false } }));
        return;
      }
      const err = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      setMsg((m) => ({ ...m, [sid]: { text: res.status === 401 ? "Sesi berakhir. Masuk lagi lalu simpan ulang." : (err ?? "Gagal menyimpan."), bad: true } }));
    } catch {
      setMsg((m) => ({ ...m, [sid]: { text: "Tidak dapat terhubung. Pilihan Anda masih di layar; coba simpan lagi.", bad: true } }));
    } finally {
      setBusy((b) => ({ ...b, [sid]: false }));
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
            <p className={styles.when} data-testid="jadwal-when">
              {tgl(savedW[p.id]?.tanggal ?? p.tanggal)}
              {savedW[p.id]?.jamMulai ? `, ${savedW[p.id].jamMulai} - ${savedW[p.id].jamSelesai}` : ""}
            </p>
            {waktuTerkunci ? null : (
              <fieldset className={styles.picker} data-testid="jadwal-waktu">
                <legend className={styles.legend}>Tanggal dan jam {p.agenda || `pertemuan ${p.urutan}`}</legend>
                <div className={styles.timeGrid}>
                  <label className={styles.fld}>
                    Tanggal
                    <input type="date" className={styles.input} value={draftW[p.id]?.tanggal ?? ""} min={mulai || undefined} max={plusYear(mulai) || undefined} onChange={(e) => editW(p.id, "tanggal", e.target.value)} />
                  </label>
                  <label className={styles.fld}>
                    Jam mulai
                    <input type="time" className={styles.input} value={draftW[p.id]?.jamMulai ?? ""} onChange={(e) => editW(p.id, "jamMulai", e.target.value)} />
                  </label>
                  <label className={styles.fld}>
                    Jam selesai
                    <input type="time" className={styles.input} value={draftW[p.id]?.jamSelesai ?? ""} onChange={(e) => editW(p.id, "jamSelesai", e.target.value)} />
                  </label>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    onClick={() => void saveWaktu(p.id)}
                    disabled={busyW[p.id] || JSON.stringify(draftW[p.id]) === JSON.stringify(savedW[p.id])}
                  >
                    {busyW[p.id] ? "Menyimpan..." : "Simpan jadwal"}
                  </button>
                </div>
                <p role="status" className={`${styles.msg} ${msgW[p.id]?.bad ? styles.error : styles.ok}`} data-testid="jadwal-waktu-msg">{msgW[p.id]?.text ?? ""}</p>
              </fieldset>
            )}
            <p className={styles.current}>
              Pewarta: {cur.length > 0 ? cur.map((i) => nama.get(i)).join(", ") : "belum ditugaskan"}
            </p>
            {!terkunci && hidden[p.id] > 0 && msg[p.id]?.text !== "Tersimpan." ? (
              <p className={styles.warn}>{hidden[p.id]} pewarta yang tercatat sudah tidak aktif dan akan dilepas saat disimpan.</p>
            ) : null}
            {terkunci ? null : (
              <div className={styles.actions}>
                <button type="button" className={styles.btn} aria-expanded={isOpen} aria-controls={`pick-${p.id}`} onClick={() => setOpen(isOpen ? null : p.id)}>
                  {isOpen ? "Tutup pilihan" : "Ubah pewarta"}
                </button>
              </div>
            )}
            {isOpen && !terkunci ? (
              <fieldset className={styles.picker} id={`pick-${p.id}`}>
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
            {terkunci ? null : (
            <div className={styles.actions}>
              <button type="button" className={styles.btnPrimary} onClick={() => save(p.id)} disabled={busy[p.id] || !dirty}>
                {busy[p.id] ? "Menyimpan..." : "Simpan pewarta"}
              </button>
            </div>
            )}
            <p role="status" className={`${styles.msg} ${m?.bad ? styles.error : styles.ok}`}>{m?.text ?? ""}</p>
          </li>
        );
      })}
    </ol>
  );
}
