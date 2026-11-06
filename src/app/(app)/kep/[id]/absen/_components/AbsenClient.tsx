"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearDead, deadLetters, enqueue, flush, pendingOps, type DeadOp, type QueuedOp, type SendResult } from "@/lib/offline/queue";
import HeaderCount from "./HeaderCount";
import PesertaRow, { type Peserta } from "./PesertaRow";
import UndoToast, { type Toast } from "./UndoToast";
import styles from "../absen.module.css";

export type PertemuanOpt = { id: string; agenda: string; tanggal: string };
type Sheet = { peserta: Peserta[]; hadirCount: number; aktifCount: number };
type Semua = { phase: "confirm" | "running" | "error"; updated: number; total: number; error?: string };

const newOpId = () => {
  try {
    return crypto.randomUUID().replaceAll("-", "");
  } catch {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  }
};
const tgl = (d: string) =>
  d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";

export default function AbsenClient({
  kepId,
  sub,
  pertemuan,
  today,
  initial,
}: {
  kepId: string;
  sub: PertemuanOpt;
  pertemuan: PertemuanOpt[];
  today: string;
  initial: Sheet;
}) {
  const router = useRouter();
  const setUrl = `/api/kep/${kepId}/absen/${sub.id}/set`;
  const semuaUrl = `/api/kep/${kepId}/absen/${sub.id}/semua`;
  const sheetUrl = `/api/kep/${kepId}/absen/${sub.id}`;
  const mundurUrl = (pid: string) => `/api/kep/${kepId}/peserta/${pid}/mundur`;

  const [peserta, setPeserta] = useState<Peserta[]>(initial.peserta);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(0);
  const [dead, setDead] = useState(0);
  const [offline, setOffline] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authLost, setAuthLost] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [semua, setSemua] = useState<Semua | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inflight = useRef(new Map<string, number>()); // pendaftaranId -> ops not yet answered
  const errors = useRef(new Map<string, string>()); // opId -> server message
  const handledDead = useRef(new Set<string>());
  const semuaOp = useRef<string | null>(null);
  const toastKey = useRef(0);
  const nameOf = useRef(new Map<string, string>());
  nameOf.current = new Map(peserta.map((p) => [p.id, p.nama]));

  const patch = useCallback((pid: string, f: Partial<Peserta>) => setPeserta((l) => l.map((p) => (p.id === pid ? { ...p, ...f } : p))), []);
  const totalInflight = () => [...inflight.current.values()].reduce((a, b) => a + b, 0);
  const bump = (pid: string, d: number) => inflight.current.set(pid, Math.max(0, (inflight.current.get(pid) ?? 0) + d));

  /** The server is the authority: when nothing is in flight, replace local state with its sheet. */
  const resync = useCallback(async () => {
    try {
      const res = await fetch(sheetUrl, { credentials: "same-origin" });
      if (res.status === 401) return setAuthLost(true);
      if (!res.ok) return;
      const s = (await res.json()) as Sheet;
      if (totalInflight() === 0) setPeserta(s.peserta);
    } catch {
      /* offline: keep what we have */
    }
  }, [sheetUrl]);

  const refreshCounts = useCallback(async () => {
    setPending((await pendingOps()).length);
    setDead((await deadLetters()).length);
  }, []);

  const send = useCallback(
    async (op: QueuedOp): Promise<SendResult> => {
      const parsed = parseOp(op, kepId, sub.id);
      try {
        const res = await fetch(op.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(op.body),
        });
        setOffline(false);
        if (res.ok) {
          const j = (await res.json().catch(() => null)) as { hadir?: unknown } | null;
          if (parsed) {
            bump(parsed.pid, -1);
            if (parsed.kind === "set" && typeof j?.hadir === "boolean" && (inflight.current.get(parsed.pid) ?? 0) === 0) patch(parsed.pid, { hadir: j.hadir });
          }
          setAuthLost(false);
          return true;
        }
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        if (j?.error) errors.current.set(op.opId, j.error);
        if (res.status === 401) setAuthLost(true);
        return res.status;
      } catch {
        setOffline(true);
        return false;
      }
    },
    [kepId, sub.id, patch],
  );

  const onDead = useCallback(
    (list: DeadOp[]) => {
      const fresh = list.filter((d) => !handledDead.current.has(d.opId));
      for (const d of fresh) {
        handledDead.current.add(d.opId);
        const parsed = parseOp(d, kepId, sub.id);
        if (!parsed) continue;
        bump(parsed.pid, -1);
        // Revert the optimistic change right away, then let the server's sheet decide.
        if (parsed.kind === "set") patch(parsed.pid, { hadir: !parsed.hadir });
        else patch(parsed.pid, { mundur: !parsed.batal });
        const nama = nameOf.current.get(parsed.pid) ?? "peserta";
        setNotice(`Perubahan untuk ${nama} ditolak: ${errors.current.get(d.opId) || `kode ${d.status}`}. Tampilan dikembalikan.`);
      }
      if (fresh.length) void resync();
    },
    [kepId, sub.id, patch, resync],
  );

  const doFlush = useCallback(async () => {
    for (;;) {
      const r = await flush(send);
      if (r.dead.length) onDead(r.dead);
      await refreshCounts();
      if (r.pending === 0) {
        if (r.sent > 0 || r.dead.length > 0) void resync();
        return;
      }
      // Progress made but ops remain (enqueued during the run): go again. Otherwise wait for signal/timer.
      if (r.sent + r.dead.length === 0 || (await pendingOps()).length === 0) return;
    }
  }, [send, onDead, refreshCounts, resync]);

  // Mount: overlay ops that survived a reload, then try to send them.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const q = await pendingOps();
      if (!alive) return;
      for (const op of q) {
        const parsed = parseOp(op, kepId, sub.id);
        if (!parsed) continue;
        bump(parsed.pid, 1);
        if (parsed.kind === "set") patch(parsed.pid, { hadir: parsed.hadir });
        else patch(parsed.pid, { mundur: !parsed.batal });
      }
      await refreshCounts();
      const old = (await deadLetters()).length;
      if (old > 0 && alive) setNotice(`${old} perubahan sebelumnya gagal terkirim dan sudah dibatalkan. Periksa daftar hadir.`);
      if (q.length) void doFlush();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const go = () => void doFlush();
    window.addEventListener("online", go);
    document.addEventListener("visibilitychange", go);
    return () => {
      window.removeEventListener("online", go);
      document.removeEventListener("visibilitychange", go);
    };
  }, [doFlush]);

  useEffect(() => {
    if (pending === 0) return;
    const t = setInterval(() => void doFlush(), 5000);
    return () => clearInterval(t);
  }, [pending, doFlush]);

  const push = useCallback(
    (pid: string, url: string, body: Record<string, unknown>) => {
      const opId = newOpId();
      bump(pid, 1);
      setPending((n) => n + 1);
      void enqueue({ opId, url, body: { ...body, opId } }).then(() => doFlush());
    },
    [doFlush],
  );

  const showToast = (text: string, undo: () => void) => setToast({ key: ++toastKey.current, text, undo });

  const commitSet = useCallback(
    (pid: string, hadir: boolean) => {
      patch(pid, { hadir });
      push(pid, setUrl, { pendaftaranId: pid, hadir });
    },
    [patch, push, setUrl],
  );
  const commitMundur = useCallback(
    (pid: string, batal: boolean) => {
      patch(pid, { mundur: !batal });
      push(pid, mundurUrl(pid), batal ? { batal: true } : {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch, push, kepId],
  );

  const onToggle = (p: Peserta) => {
    const hadir = !p.hadir;
    setNotice(null);
    commitSet(p.id, hadir);
    showToast(`${p.nama}: ${hadir ? "hadir" : "belum hadir"}`, () => commitSet(p.id, !hadir));
  };
  const onMundur = (p: Peserta, batal: boolean) => {
    setNotice(null);
    commitMundur(p.id, batal);
    showToast(batal ? `${p.nama}: pengunduran diri dibatalkan` : `${p.nama}: mengundurkan diri`, () => commitMundur(p.id, !batal));
  };

  const aktif = peserta.filter((p) => !p.mundur);
  const hadirCount = aktif.filter((p) => p.hadir).length;
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? peserta.filter((p) => p.nama.toLowerCase().includes(q)) : peserta), [peserta, q]);

  async function runSemua(total: number) {
    const opId = (semuaOp.current ??= newOpId());
    setSemua({ phase: "running", updated: 0, total });
    try {
      for (;;) {
        const res = await fetch(semuaUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ opId }),
        });
        const j = (await res.json().catch(() => null)) as { updated?: number; remaining?: number; error?: string } | null;
        if (!res.ok || typeof j?.remaining !== "number") {
          if (res.status === 401) setAuthLost(true);
          return setSemua({ phase: "error", updated: 0, total, error: j?.error ?? "Gagal menandai semua. Coba lagi." });
        }
        setSemua({ phase: "running", updated: j.updated ?? 0, total });
        if (j.remaining === 0) break;
      }
      semuaOp.current = null;
      setSemua(null);
      await resync();
    } catch {
      setSemua({ phase: "error", updated: 0, total, error: "Tidak ada sinyal. Coba lagi; kemajuan tidak hilang." });
    }
  }

  const onListKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!t.hasAttribute("data-row-main")) return;
    const btns = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-row-main]") ?? [])];
    const i = btns.indexOf(t);
    const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : null;
    if (to === null || !btns[to]) return;
    e.preventDefault();
    btns[to].focus();
  };

  const isToday = sub.tanggal === today;
  const state = dead > 0 ? "gagal" : pending > 0 ? (offline ? "offline" : "kirim") : "ok";
  const statusText = [
    pending > 0 ? (offline ? `menunggu sinyal (${pending})` : `menyimpan (${pending})`) : dead === 0 ? "tersimpan" : "",
    dead > 0 ? `${dead} gagal` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <main className={styles.page} onClick={(e) => menuFor && !(e.target as HTMLElement).closest("[role=menu],[aria-haspopup]") && setMenuFor(null)}>
      <header className={styles.head}>
        <Link prefetch={false} href={`/kep/${kepId}`} className={styles.back}>
          ← Kembali ke KEP
        </Link>
        <h1 className={styles.title} data-testid="pertemuan-judul">
          <span>{sub.agenda || "Pertemuan"}</span>
          <span className={styles.date}>
            {tgl(sub.tanggal)} {isToday ? <strong className={styles.today}>Hari ini</strong> : <span className={styles.notToday}>Bukan hari ini</span>}
          </span>
        </h1>
        {pertemuan.length > 1 && (
          <label className={styles.pick}>
            Pertemuan
            <select value={sub.id} onChange={(e) => router.push(`/kep/${kepId}/absen?p=${e.target.value}`)}>
              {pertemuan.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.tanggal} - {p.agenda || "Pertemuan"}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className={styles.bar}>
          <HeaderCount hadir={hadirCount} aktif={aktif.length} />
          <span className={`${styles.sync} ${styles[`sync_${state}`]}`} data-testid="sync-status" data-state={state}>
            {statusText}
          </span>
        </div>
        <input type="search" className={styles.search} placeholder="Cari nama peserta" aria-label="Cari nama peserta" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>

      {authLost && (
        <p className={styles.alert} role="alert">
          Sesi berakhir. <Link href="/login">Masuk lagi</Link>. Perubahan yang belum terkirim tetap aman di perangkat ini.
        </p>
      )}
      {notice && (
        <p className={styles.alert} role="alert">
          {notice}{" "}
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => {
              setNotice(null);
              void clearDead().then(() => {
                handledDead.current.clear();
                return refreshCounts();
              });
            }}
          >
            Tutup
          </button>
        </p>
      )}

      <ul className={styles.list} ref={listRef} onKeyDown={onListKey} aria-label="Daftar peserta">
        {shown.map((p) => (
          <PesertaRow key={p.id} p={p} menuOpen={menuFor === p.id} onToggle={onToggle} onMenu={setMenuFor} onMundur={onMundur} />
        ))}
      </ul>
      {shown.length === 0 && <p className={styles.empty}>{q ? "Tidak ada peserta yang cocok." : "Tidak ada peserta."}</p>}

      <div className={styles.foot}>
        <button type="button" className={styles.all} disabled={aktif.every((p) => p.hadir) || !!semua} onClick={() => setSemua({ phase: "confirm", updated: 0, total: aktif.filter((p) => !p.hadir).length })}>
          Tandai semua hadir
        </button>
      </div>

      <UndoToast toast={toast} onClose={() => setToast(null)} />

      {semua && (
        <div className={styles.overlay}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="semua-judul"
            aria-describedby="semua-isi"
            className={styles.dialog}
            onKeyDown={(e) => e.key === "Escape" && semua.phase !== "running" && setSemua(null)}
          >
            <h2 id="semua-judul">Tandai semua hadir?</h2>
            {semua.phase === "confirm" && (
              <>
                <p id="semua-isi">
                  Semua peserta aktif yang belum hadir ({semua.total} orang) akan ditandai hadir di pertemuan ini. Peserta yang mengundurkan diri tidak ikut.
                </p>
                <div className={styles.dialogBtns}>
                  <button type="button" className={styles.primary} onClick={() => void runSemua(semua.total)}>
                    Ya, tandai semua
                  </button>
                  <button type="button" className={styles.secondary} autoFocus onClick={() => setSemua(null)}>
                    Batal
                  </button>
                </div>
              </>
            )}
            {semua.phase === "running" && (
              <p id="semua-isi">
                <progress value={semua.updated} max={Math.max(semua.total, 1)} /> <span>{`Memproses… ${semua.updated} dari ${semua.total}`}</span>
              </p>
            )}
            {semua.phase === "error" && (
              <>
                <p id="semua-isi" className={styles.errText}>
                  {semua.error}
                </p>
                <div className={styles.dialogBtns}>
                  <button type="button" className={styles.primary} onClick={() => void runSemua(semua.total)}>
                    Coba lagi
                  </button>
                  <button type="button" className={styles.secondary} onClick={() => setSemua(null)}>
                    Tutup
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

type Parsed = { kind: "set"; pid: string; hadir: boolean } | { kind: "mundur"; pid: string; batal: boolean };

/** Which row an op touches; ops of other pertemuan/KEP still flush but do not affect this screen. */
function parseOp(op: QueuedOp, kepId: string, subId: string): Parsed | null {
  const b = op.body as { pendaftaranId?: string; hadir?: boolean; batal?: boolean };
  if (op.url === `/api/kep/${kepId}/absen/${subId}/set` && typeof b.pendaftaranId === "string" && typeof b.hadir === "boolean")
    return { kind: "set", pid: b.pendaftaranId, hadir: b.hadir };
  const m = op.url.match(new RegExp(`^/api/kep/${kepId}/peserta/([A-Za-z0-9]+)/mundur$`));
  return m ? { kind: "mundur", pid: m[1], batal: b.batal === true } : null;
}
