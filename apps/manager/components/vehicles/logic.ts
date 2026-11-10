/**
 * The vehicles and parking screens' rules (ADR 0045), as the API holds them
 * (src/gate/vehicles/vehicle-rules.ts, parking/parking-rules.ts,
 * fines/fine-rules.ts). Plain TypeScript with no imports, so the tests run
 * it as is.
 */

/** A sticker number: letters, digits and dashes, 1–20 (upper-cased by the API). */
export function validSticker(value: string): boolean {
  return /^[A-Za-z0-9-]{1,20}$/.test(value.trim());
}

/**
 * What the API refuses as PERMIT_DATE_OUT_OF_RANGE, said before it is sent:
 * the problem's code, which the page words (`date.<code>` in its catalog).
 */
export type PermitDateProblem = 'pick_day' | 'not_before_current' | 'after_today' | 'too_far';

export function permitDateProblem(day: string, today: string, notBefore?: string): PermitDateProblem | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'pick_day';
  const min = addDays(today, 1);
  const floor = notBefore && notBefore > min ? notBefore : min;
  if (day < floor) return notBefore && notBefore >= min ? 'not_before_current' : 'after_today';
  if (day > addDays(today, 731)) return 'too_far';
  return undefined;
}

/** A local day `n` days after `day` (`YYYY-MM-DD`). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface Window {
  startsAt: string;
  endsAt: string;
}

/**
 * The most bookings holding one instant inside [from, to): the area's peak
 * use, as the API counts it (peakOverlap), windows half-open.
 */
export function peakUse(windows: readonly Window[], from: string, to: string): number {
  const lo = Date.parse(from);
  const hi = Date.parse(to);
  const events: [number, number][] = [];
  for (const w of windows) {
    const start = Math.max(Date.parse(w.startsAt), lo);
    const end = Math.min(Date.parse(w.endsAt), hi);
    if (start < end) events.push([start, 1], [end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let held = 0;
  let peak = 0;
  for (const [, d] of events) {
    held += d;
    peak = Math.max(peak, held);
  }
  return peak;
}

/** EGP, more than 0 and at most 100,000, two decimals at most (fine-rules.ts). */
export function validFineAmount(value: string): boolean {
  return /^(?!0+(\.0{1,2})?$)\d{1,6}(\.\d{1,2})?$/.test(value.trim()) && Number(value) <= 100_000;
}

export type FineAction = 'decide' | 'cancel' | 'pay';

/** What the staff may do on a fine, by its status and their permissions. */
export function fineActions(status: string, can: { issue: boolean; billing: boolean }): FineAction[] {
  const out: FineAction[] = [];
  if (status === 'under_appeal' && can.issue) out.push('decide');
  if (status === 'unpaid' && can.issue) out.push('cancel');
  if (status === 'unpaid' && can.billing) out.push('pay');
  return out;
}

/**
 * "A-12 (Active)" for each match of a report, listed in the page's language,
 * or the page's word when none. The words come from the page: `none` from
 * its catalog, `status` from `useLabel`, `list` from `fmt.list`.
 */
export function matchesText(
  matches: readonly { unitCode: string; permitStatus: string }[],
  words: { none: string; status: (code: string) => string; list: (items: readonly string[]) => string },
): string {
  if (!matches.length) return words.none;
  return words.list(matches.map((m) => `${m.unitCode} (${words.status(m.permitStatus)})`));
}
