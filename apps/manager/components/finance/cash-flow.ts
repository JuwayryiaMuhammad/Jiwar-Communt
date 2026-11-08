/**
 * Cash flow's words (ADR 0091): the collection rate and its basis, and the
 * days of cover. Plain TypeScript, no imports.
 */

/** The rate as a percentage, or a dash with no history. */
export function cashFlowRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 1000) / 10}%`;
}

/** Where the rate comes from: the window's invoices, or none at all. */
export function cashFlowBasis(c: { basis: string; from: string; to: string; due: string; collected: string }): string {
  return c.basis === 'no_history'
    ? 'Nothing fell due in the last 90 days: no resident money is expected'
    : `${c.collected} of ${c.due} due ${c.from} – ${c.to}`;
}

/** Days of spending the cash covers, or a dash when it cannot be computed. */
export function liquidityText(days: number | null | undefined): string {
  if (days === null || days === undefined) return '—';
  return `${days} day${days === 1 ? '' : 's'}`;
}
