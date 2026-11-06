import styles from "../absen.module.css";

export default function HeaderCount({ hadir, aktif }: { hadir: number; aktif: number }) {
  // One text node ("3 dari 12 hadir") so screen readers and tests read it as a sentence.
  return (
    <p className={styles.count} data-testid="hadir-count">
      {`${hadir} dari ${aktif} hadir`}
    </p>
  );
}
