import type { Prisma } from '@prisma/client';

/** A line as compared: its texts and amount. */
export interface ComparedLine {
  position: number;
  descriptionEn: string;
  descriptionAr: string;
  amount: Prisma.Decimal;
}

export const LINE_CHANGES = ['same', 'added', 'removed', 'changed'] as const;
export type LineChange = (typeof LINE_CHANGES)[number];

/** Why a plan's line changed (ADR 0069), deterministic, never a guess. */
export const CHANGE_CAUSES = [
  'plan_amount_changed',
  'unit_terms',
  'other',
] as const;
export type ChangeCause = (typeof CHANGE_CAUSES)[number];

export interface LinePair {
  current: ComparedLine | null;
  previous: ComparedLine | null;
  change: LineChange;
}

/**
 * An invoice's lines against the one before (ADR 0069). A plan's invoices
 * hold its one line each: they pair by position. Any other pairs a line
 * with the first unpaired line of the same English text; what is left is
 * added (now only) or removed (before only), in the current invoice's
 * order, then the previous one's.
 */
export function pairLines(
  current: readonly ComparedLine[],
  previous: readonly ComparedLine[],
  byPosition: boolean,
): LinePair[] {
  const used = new Set<number>();
  const pairs: LinePair[] = current.map((line) => {
    const match = previous.find(
      (p) =>
        !used.has(p.position) &&
        (byPosition
          ? p.position === line.position
          : p.descriptionEn === line.descriptionEn),
    );
    if (!match) return { current: line, previous: null, change: 'added' };
    used.add(match.position);
    return {
      current: line,
      previous: match,
      change: match.amount.equals(line.amount) ? 'same' : 'changed',
    };
  });
  for (const p of previous)
    if (!used.has(p.position))
      pairs.push({ current: null, previous: p, change: 'removed' });
  return pairs;
}
