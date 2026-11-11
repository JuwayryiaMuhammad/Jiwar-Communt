/**
 * Taxes' words and checks on the dashboard (ADR 0093). Plain TypeScript, no
 * imports: rates and amounts are decimal strings.
 */

/** A rate in percent: up to 100, at most two decimals. */
export function rateOk(v: string, { allowZero }: { allowZero: boolean }): boolean {
  const s = v.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return false;
  const n = Number(s);
  return n <= 100 && (allowZero || n > 0);
}

/** A threshold: an amount from zero, at most two decimals. */
export function thresholdOk(v: string): boolean {
  return /^\d{1,7}(\.\d{1,2})?$/.test(v.trim());
}

/** The list with a value added or taken out, in its first order. */
export function toggled<T extends string>(list: readonly T[], all: readonly T[], value: T): T[] {
  const on = new Set(list);
  if (on.has(value)) on.delete(value);
  else on.add(value);
  return all.filter((v) => on.has(v));
}

/** The calendar quarter of a day, `YYYY-Qn`. */
export function quarterOf(day: string): string {
  const [y = 1970, m = 1] = day.split('-').map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}

/** The last day of a `YYYY-MM` month. */
export function monthEnd(month: string): string {
  const [y = 1970, m = 1] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/** The last day of a `YYYY-Qn` quarter. */
export function quarterEnd(quarter: string): string {
  const y = quarter.slice(0, 4);
  const q = Number(quarter.slice(6));
  return monthEnd(`${y}-${String(q * 3).padStart(2, '0')}`);
}

/** The first day of a `YYYY-Qn` quarter. */
export function quarterStart(quarter: string): string {
  const y = quarter.slice(0, 4);
  const q = Number(quarter.slice(6));
  return `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
}

/** An amount of money: whole piastres, above zero. */
export function amountOk(v: string): boolean {
  return /^(?!0+(\.0{1,2})?$)\d{1,9}(\.\d{1,2})?$/.test(v.trim());
}
