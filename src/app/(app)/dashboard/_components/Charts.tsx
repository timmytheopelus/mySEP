import { Fragment, type ReactNode } from "react";
import styles from "../dashboard.module.css";

/** Server-rendered, no script. Every chart sits next to a table/card list with the same numbers (see Tabel). */

export function BarsH({ items, label }: { items: { label: string; value: number }[]; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={styles.bars} aria-label={label}>
      {items.map((i, n) => (
        <li key={`${n}-${i.label}`}>
          <span>{i.label}</span>
          <svg viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <rect x="0" y="0" width={Math.max(i.value > 0 ? 1 : 0, (i.value / max) * 100)} height="12" rx="2" fill="var(--s1)" />
          </svg>
          <b>{i.value}</b>
        </li>
      ))}
    </ul>
  );
}

/** Grouped columns: peserta (solid) and lulus (hatched, so the series differ without colour). Values are written on the bars. */
export function TrenChart({ rows }: { rows: { tahun: number; peserta: number; lulus: number }[] }) {
  const W = 560, H = 220, L = 8, B = 28, T = 18;
  const max = Math.max(1, ...rows.flatMap((r) => [r.peserta, r.lulus]));
  const slot = (W - L * 2) / Math.max(1, rows.length);
  const bw = Math.min(46, slot / 2.6);
  const h = (v: number) => ((H - B - T) * v) / max;
  return (
    <figure className={styles.fig}>
      <ul className={styles.legend}>
        <li>
          <svg viewBox="0 0 14 14" aria-hidden="true"><rect width="14" height="14" fill="var(--s1)" /></svg>Peserta
        </li>
        <li>
          <svg viewBox="0 0 14 14" aria-hidden="true"><rect width="14" height="14" fill="var(--s2)" /><path d="M0 14L14 0M-3 3L3 -3M11 17L17 11" stroke="var(--bg)" strokeWidth="2" /></svg>Lulus
        </li>
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Peserta dan lulusan per tahun, ${rows.length} tahun. Angka lengkap ada pada tabel.`}>
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--s2)" />
            <rect width="2" height="6" fill="var(--bg)" />
          </pattern>
        </defs>
        <line className={styles.axis} x1={L} x2={W - L} y1={H - B} y2={H - B} />
        {rows.map((r, i) => {
          const cx = L + slot * i + slot / 2;
          return (
            <g key={r.tahun}>
              <rect x={cx - bw - 1} y={H - B - h(r.peserta)} width={bw} height={Math.max(0, h(r.peserta))} rx="3" fill="var(--s1)" />
              <rect x={cx + 1} y={H - B - h(r.lulus)} width={bw} height={Math.max(0, h(r.lulus))} rx="3" fill="url(#hatch)" />
              <text x={cx - bw / 2 - 1} y={H - B - h(r.peserta) - 4} textAnchor="middle">{r.peserta}</text>
              <text x={cx + bw / 2 + 1} y={H - B - h(r.lulus) - 4} textAnchor="middle">{r.lulus}</text>
              <text x={cx} y={H - 8} textAnchor="middle">{r.tahun}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

type Col<R> = { head: string; cell: (r: R) => ReactNode };
/** Table on laptop, stacked cards on phone; same data, both reachable by assistive tech as only one is displayed. */
export function Tabel<R>({ caption, rows, cols, rowKey }: { caption: string; rows: R[]; cols: Col<R>[]; rowKey: (r: R) => string }) {
  if (rows.length === 0) return <p className={styles.muted}>Belum ada data.</p>;
  return (
    <>
      <table className={styles.table}>
        <caption>{caption}</caption>
        <thead>
          <tr>{cols.map((c) => <th key={c.head} scope="col">{c.head}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={`${n}-${rowKey(r)}`}>{cols.map((c, i) => (i === 0 ? <th key={c.head} scope="row">{c.cell(r)}</th> : <td key={c.head}>{c.cell(r)}</td>))}</tr>
          ))}
        </tbody>
      </table>
      <ul className={styles.cards} aria-label={caption}>
        {rows.map((r, n) => (
          <li key={`${n}-${rowKey(r)}`} className={styles.card}>
            <h3>{cols[0].cell(r)}</h3>
            <dl>{cols.slice(1).map((c) => <Fragment key={c.head}><dt>{c.head}</dt><dd>{c.cell(r)}</dd></Fragment>)}</dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function Sel({ v }: { v: number | string }) {
  return v === "*" ? <span role="img" aria-label="disembunyikan">*</span> : <>{v}</>;
}
export function ProfilTabel({ judul, data }: { judul: string; data: Record<string, number | string> }) {
  const rows = Object.entries(data).map(([k, v]) => ({ k, v }));
  return <Tabel caption={judul} rows={rows} rowKey={(r) => r.k} cols={[{ head: "Kelompok", cell: (r) => r.k }, { head: "Jumlah", cell: (r) => <Sel v={r.v} /> }]} />;
}

type ProfilData = { suppressed: true } | { suppressed: false; kelompokUsia: Record<string, number | string>; jenisKelamin: Record<string, number | string>; statusPernikahan: Record<string, number | string> };
export function ProfilBagian({ profil }: { profil: ProfilData }) {
  if (profil.suppressed)
    return <p className={styles.muted}>Profil peserta belum ditampilkan karena jumlah peserta terlalu sedikit untuk menjaga privasi.</p>;
  return (
    <>
      <p className={styles.muted}>
        Hanya angka gabungan. &quot;&lt;5&quot; berarti jumlahnya kurang dari 5 (termasuk nol). Tanda &quot;*&quot; berarti angka disembunyikan agar angka &quot;&lt;5&quot;
        di kelompok yang sama tidak dapat dihitung dari selisih.
      </p>
      <ProfilTabel judul="Kelompok usia" data={profil.kelompokUsia} />
      <ProfilTabel judul="Jenis kelamin" data={profil.jenisKelamin} />
      <ProfilTabel judul="Status pernikahan" data={profil.statusPernikahan} />
    </>
  );
}
