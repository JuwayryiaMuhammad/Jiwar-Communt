import type { Prisma, TicketPriority } from '@prisma/client';

export interface SlaTargetMinutes {
  responseMinutes: number;
  resolutionMinutes: number;
}

/**
 * The targets every category starts with, per priority (ADR 0034): the
 * default categories of a new compound, a category the manager adds later,
 * and, through the migration 20261009090000_visits_and_sla, every category
 * of an existing compound. A unit test keeps the backfill in step.
 */
export const DEFAULT_SLA_TARGETS: Readonly<
  Record<TicketPriority, SlaTargetMinutes>
> = {
  emergency: { responseMinutes: 60, resolutionMinutes: 24 * 60 },
  urgent: { responseMinutes: 4 * 60, resolutionMinutes: 72 * 60 },
  normal: { responseMinutes: 24 * 60, resolutionMinutes: 7 * 24 * 60 },
};

export const PRIORITIES: readonly TicketPriority[] = [
  'emergency',
  'urgent',
  'normal',
];

/** The three default rows of one category. */
export function defaultTargetRows(
  tenantId: string,
  categoryId: string,
): Prisma.SlaTargetCreateManyInput[] {
  return PRIORITIES.map((priority) => ({
    tenantId,
    categoryId,
    priority,
    ...DEFAULT_SLA_TARGETS[priority],
  }));
}
