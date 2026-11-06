import styles from "../dashboard.module.css";

export type UnduhLink = { href: string; label: string };
export function Unduh({ links }: { links: UnduhLink[] }) {
  return (
    <ul className={styles.links} aria-label="Unduh laporan (CSV)">
      {links.map((l) => (
        <li key={l.href}>
          <a className={styles.btn} href={l.href} download>
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
