"use client";
import { useEffect } from "react";
import styles from "../absen.module.css";

export type Toast = { key: number; text: string; undo: () => void };

/**
 * Polite live region (always mounted so screen readers pick up changes). Shows what just changed and a
 * "Batalkan" button; hides itself after 8 s.
 */
export default function UndoToast({ toast, onClose }: { toast: Toast | null; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 8000);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  return (
    <div role="status" aria-live="polite" className={styles.toastRegion}>
      {toast && (
        <div className={styles.toast}>
          <span>{toast.text}</span>
          <button
            type="button"
            className={styles.toastBtn}
            onClick={() => {
              toast.undo();
              onClose();
            }}
          >
            Batalkan
          </button>
        </div>
      )}
    </div>
  );
}
