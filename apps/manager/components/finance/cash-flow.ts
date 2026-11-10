/**
 * Cash flow's words (ADR 0091): the collection rate and its basis, and the
 * days of cover. Plain TypeScript, type imports only.
 */
import type { Format, Translate } from '@jiwar/i18n/core';
import type codes from '../../messages/en/fin-codes.ts';

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

// In the page's language (the English-only helpers above stay until their
// callers move): `t` is the fin-codes catalog, `fmt` the page's `useFormat()`.

/** The rate as a percentage in the page's language, or a dash with no history. */
export function cashFlowRateText(fmt: Pick<Format, 'percent'>, rate: number | null): string {
  return rate === null ? '—' : fmt.percent(rate);
}

/** Where the rate comes from, its amounts and days formatted. */
export function cashFlowBasisText(
  t: Translate<typeof codes>,
  fmt: Pick<Format, 'money' | 'day'>,
  c: { basis: string; from: string; to: string; due: string; collected: string },
): string {
  return c.basis === 'no_history'
    ? t('cashFlow.noHistory')
    : t('cashFlow.basis', { collected: fmt.money(c.collected), due: fmt.money(c.due), from: fmt.day(c.from), to: fmt.day(c.to) });
}

/** Days of spending the cash covers, or a dash when it cannot be computed. */
export function liquidityDays(t: Translate<typeof codes>, days: number | null | undefined): string {
  return days === null || days === undefined ? '—' : t('cashFlow.days', { n: days });
}
