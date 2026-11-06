/**
 * Spreadsheet formula-injection guard: text a spreadsheet could execute gets a leading single quote.
 * Covers = + - @ (also after leading whitespace, and their full-width forms) and leading tab / CR / LF.
 * Callers keep real numbers as numbers and only pass strings here.
 */
const DANGEROUS = /^(?:[\t\r\n]|\s*[=+\-@＝＋－＠])/;
export function neutralize(cell: string): string {
  return DANGEROUS.test(cell) ? `'${cell}` : cell;
}
