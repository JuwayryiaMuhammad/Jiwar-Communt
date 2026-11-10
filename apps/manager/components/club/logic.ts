/**
 * The club screens' rules (ADR 0044). Plain TypeScript with type-only
 * imports, so the tests run it as is.
 */
import type { Translate } from '@jiwar/i18n/core';
import type clubEn from '../../messages/en/money-club.ts';

const DURATIONS = ['monthly', 'quarterly', 'annual', 'custom'] as const;
const isDuration = (k: string): k is (typeof DURATIONS)[number] => (DURATIONS as readonly string[]).includes(k);

/** "Monthly", or "45 days", in the page's language. */
export function durationText(plan: { durationKind: string; durationDays: number | null }, t: Translate<typeof clubEn>): string {
  if (plan.durationKind === 'custom') return t('durationDays', { n: plan.durationDays ?? 0 });
  return isDuration(plan.durationKind) ? t(`duration.${plan.durationKind}`) : plan.durationKind;
}

/** The unit's people, as the API names them for coverage. */
export interface PersonRef {
  kind: 'occupancy' | 'member';
  id: string;
}

export const refKey = (p: PersonRef) => `${p.kind}:${p.id}`;

/** The coverage body: occupancies and members by id. */
export const coverageBody = (people: readonly PersonRef[]) =>
  people.map((p) => (p.kind === 'occupancy' ? { occupancyId: p.id } : { memberId: p.id }));

/** Whether two selections name the same people. */
export function sameSelection(a: readonly PersonRef[], b: readonly PersonRef[]): boolean {
  const k = (xs: readonly PersonRef[]) => xs.map(refKey).sort().join('|');
  return k(a) === k(b);
}

export type PaidOnProblem = 'pickDay' | 'future' | 'tooOld';

/**
 * The last 90 days up to today, as the API takes `paidOn`: what is wrong
 * with a day, as the key the page shows (`paidOn.<problem>` in money-club).
 */
export function paidOnProblem(value: string, today: string): PaidOnProblem | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'pickDay';
  if (value > today) return 'future';
  const [y = 0, m = 1, d = 1] = today.split('-').map(Number);
  const earliest = new Date(Date.UTC(y, m - 1, d - 90)).toISOString().slice(0, 10);
  return value < earliest ? 'tooOld' : undefined;
}
