"use client";
import styles from "./kesehatan.module.css";

export default function PrintButton() {
  return (
    <button type="button" className={styles.btn} onClick={() => window.print()}>
      Cetak (A4)
    </button>
  );
}
