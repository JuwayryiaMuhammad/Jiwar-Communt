/**
 * The club screens' rules (ADR 0044). Plain TypeScript with no imports, so
 * the tests run it as is.
 */

export const DURATION_TEXT: Record<string, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
  custom: 'Custom',
};

/** "Monthly", or "45 days". */
export function durationText(plan: { durationKind: string; durationDays: number | null }): string {
  return plan.durationKind === 'custom' ? `${plan.durationDays} days` : (DURATION_TEXT[plan.durationKind] ?? plan.durationKind);
}

/** "1,500.00 EGP". */
export function egp(amount: string | null): string {
  if (amount === null) return '—';
  return `${Number(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`;
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

/** The last 90 days up to today, as the API takes `paidOn`. */
export function paidOnProblem(value: string, today: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Pick a day.';
  if (value > today) return 'Not in the future.';
  const [y = 0, m = 1, d = 1] = today.split('-').map(Number);
  const earliest = new Date(Date.UTC(y, m - 1, d - 90)).toISOString().slice(0, 10);
  return value < earliest ? 'At most 90 days ago.' : undefined;
}
