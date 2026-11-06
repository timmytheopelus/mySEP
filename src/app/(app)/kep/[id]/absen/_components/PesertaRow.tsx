"use client";
import { useRef } from "react";
import styles from "../absen.module.css";

export type Peserta = { id: string; nama: string; hadir: boolean; mundur: boolean };

export default function PesertaRow({
  p,
  menuOpen,
  onToggle,
  onMenu,
  onMundur,
}: {
  p: Peserta;
  menuOpen: boolean;
  onToggle: (p: Peserta) => void;
  onMenu: (id: string | null) => void;
  onMundur: (p: Peserta, batal: boolean) => void;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    onMenu(null);
    moreRef.current?.focus();
  };
  return (
    <li
      className={`${styles.row} ${p.hadir && !p.mundur ? styles.rowOn : ""} ${p.mundur ? styles.rowMundur : ""}`}
      data-testid="peserta-row"
      data-mundur={p.mundur ? "true" : undefined}
    >
      <button
        type="button"
        data-row-main
        className={styles.rowMain}
        aria-pressed={p.mundur ? undefined : p.hadir}
        aria-disabled={p.mundur ? true : undefined}
        onClick={() => !p.mundur && onToggle(p)}
      >
        <span className={styles.box} aria-hidden="true">
          {p.hadir && !p.mundur ? "✓" : ""}
        </span>
        <span className={styles.nama}>{p.nama}</span>
        {p.mundur ? (
          <span className={styles.badge}>Mengundurkan diri</span>
        ) : (
          <span className={styles.state} aria-hidden="true">
            {p.hadir ? "Hadir" : ""}
          </span>
        )}
      </button>
      <button
        ref={moreRef}
        type="button"
        className={styles.more}
        aria-label={`Menu untuk ${p.nama}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => onMenu(menuOpen ? null : p.id)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {menuOpen && (
        <div role="menu" className={styles.menu} onKeyDown={(e) => menuKey(e, close)}>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            autoFocus
            onClick={() => {
              onMenu(null);
              if (p.mundur) moreRef.current?.focus();
              onMundur(p, p.mundur);
            }}
          >
            {p.mundur ? "Batalkan pengunduran diri" : "Mengundurkan diri"}
          </button>
        </div>
      )}
    </li>
  );
}

function menuKey(e: React.KeyboardEvent<HTMLDivElement>, close: () => void) {
  if (e.key === "Escape") return close();
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
}
