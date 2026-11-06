/**
 * Fixed KEP meeting template. SINGLE source of truth: the final order and count are to be confirmed
 * by the owner before merge (flagged in the PR). Edit only this list; `urutan` must stay 1..N.
 * The last two entries are the retreat days: the schedule puts day 1 one week after the last regular
 * meeting and day 2 on the next day (see scheduleDates).
 */
const AGENDA: string[] = [
  "Misa Pembukaan",
  "Bab 1",
  "Bab 2",
  "Bab 2",
  "Evangelii Nuntiandi",
  "Evangelii Nuntiandi",
  ...[3, 4, 5, 6, 7, 8, 9].flatMap((b) => [`Bab ${b}`, `Bab ${b}`]),
  "Bab 10",
  "Bab 10",
  "Maria Bintang Evangelisasi",
  "Iman Katolik",
  "Bab 10 (praktik)",
  "Evaluasi Kunjungan rumah",
  "Retreat Pengutusan hari 1",
  "Retreat Pengutusan hari 2",
];

export const KEP_TEMPLATE: { urutan: number; agenda: string }[] = AGENDA.map((agenda, i) => ({ urutan: i + 1, agenda }));

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict YYYY-MM-DD -> UTC midnight ms (rejects 2027-02-30 and any non-date-only text). */
export function parseIsoDate(iso: string): number {
  const m = typeof iso === "string" ? ISO_DATE.exec(iso) : null;
  if (!m) throw new Error("Tanggal tidak valid");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new Error("Tanggal tidak valid");
  return t;
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One date per template entry. Pure UTC calendar arithmetic on date-only values (no local time zone,
 * so no drift in Asia/Jakarta or anywhere else): weekly from `startISO`; the final entry is
 * the previous one + 1 day (retreat day 2); retreat day 1 is the last regular meeting + 7 days.
 */
export function scheduleDates(startISO: string): string[] {
  const start = parseIsoDate(startISO);
  const n = KEP_TEMPLATE.length;
  return KEP_TEMPLATE.map((_, i) => fmt(start + (i === n - 1 ? (n - 2) * 7 + 1 : i * 7) * DAY_MS));
}
