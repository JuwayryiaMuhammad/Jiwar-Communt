import type { BoardRole } from '@prisma/client';

/** A board's size (ADR 0051): appointed or elected. */
export const BOARD_SEATS = { min: 3, max: 15 } as const;
/** An appointed board's term, in days from now. */
export const APPOINTED_TERM_DAYS = { min: 30, max: 5 * 366 } as const;

/** The offices one member holds at most, each. */
export const OFFICES: readonly BoardRole[] = [
  'chair',
  'secretary',
  'treasurer',
];

export type TermStatus = 'current' | 'lapsed' | 'ended';

/** A term's status at `now`: ended, current, or past its end with no successor. */
export function termStatus(
  t: { endedAt: Date | null; endsAt: Date },
  now: Date,
): TermStatus {
  if (t.endedAt) return 'ended';
  return t.endsAt > now ? 'current' : 'lapsed';
}

/** The office (not `member`) held twice in a list of roles, or null. */
export function doubledOffice(roles: readonly BoardRole[]): BoardRole | null {
  for (const office of OFFICES)
    if (roles.filter((r) => r === office).length > 1) return office;
  return null;
}
