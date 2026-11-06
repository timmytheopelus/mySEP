"use client";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import styles from "../absen.module.css";

/**
 * Modal alertdialog: focuses [data-autofocus] (else the first button), traps Tab, closes on Escape
 * (when onClose is given) and returns focus to `returnFocus()` (or the previously focused element).
 */
export default function Dialog({
  labelId,
  descId,
  onClose,
  returnFocus,
  children,
}: {
  labelId: string;
  descId: string;
  onClose?: () => void;
  returnFocus?: () => HTMLElement | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ret = useRef(returnFocus);
  useEffect(() => {
    ret.current = returnFocus;
  });
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = ref.current;
    (root?.querySelector<HTMLElement>("[data-autofocus]") ?? root?.querySelector<HTMLElement>("button"))?.focus();
    return () => {
      const target = ret.current?.() ?? before;
      if (target && document.contains(target)) target.focus();
    };
  }, []);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && onClose) return onClose();
    if (e.key !== "Tab") return;
    const f = [...(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled]),[href],input,select,textarea") ?? [])];
    if (f.length === 0) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    const to = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
    e.preventDefault();
    f[to].focus();
  };
  return (
    <div className={styles.overlay}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={labelId} aria-describedby={descId} className={styles.dialog} onKeyDown={onKey}>
        {children}
      </div>
    </div>
  );
}
