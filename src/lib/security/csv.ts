/** Spreadsheet formula-injection guard: text a spreadsheet could execute gets a leading single quote. */
const DANGEROUS = /^[=+\-@\t\r]/;
export function neutralize(cell: string): string {
  return DANGEROUS.test(cell) ? `'${cell}` : cell;
}
