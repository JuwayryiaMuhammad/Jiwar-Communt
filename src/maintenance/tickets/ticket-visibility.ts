import type { Prisma, Ticket } from '@prisma/client';

/**
 * Who opened a ticket (ADR 0064): a resident (or dispatch for one), or the
 * compound itself: a maintenance plan, an inspection's finding, a fault a
 * technician found. The migration's CHECK repeats the list.
 */
export const TICKET_ORIGINS = [
  'resident',
  'plan',
  'inspection',
  'field',
] as const;
export type TicketOrigin = (typeof TICKET_ORIGINS)[number];
export type StaffOrigin = Exclude<TicketOrigin, 'resident'>;

/**
 * THE rule for the resident side (ADR 0064), written once: which tickets a
 * resident list, a resident read, a resident notice or a personal-data
 * export may ever show.
 *
 *  - every resident ticket (its usual reach then applies: the reporter,
 *    the creator, the unit's primary);
 *  - a technician's field ticket on an asset in a unit: the household has
 *    to let the technician in, so it sees it and its visits;
 *  - no other work order of the compound's, ever.
 *
 * Both forms below are read from this one list: the database filter every
 * resident list ANDs in, and the check a single read makes.
 */
const RESIDENT_SIDE: readonly {
  origin: TicketOrigin;
  inUnit: boolean | null;
}[] = [
  { origin: 'resident', inUnit: null },
  { origin: 'field', inUnit: true },
];

/** The filter: AND it into every resident-side query of tickets. */
export const RESIDENT_VISIBLE: Prisma.TicketWhereInput = {
  OR: RESIDENT_SIDE.map((r) => ({
    origin: r.origin,
    ...(r.inUnit === null
      ? {}
      : r.inUnit
        ? { unitId: { not: null } }
        : { unitId: null }),
  })),
};

/** The check, for one ticket already read. */
export function residentVisible(t: Pick<Ticket, 'origin' | 'unitId'>): boolean {
  return RESIDENT_SIDE.some(
    (r) =>
      r.origin === t.origin &&
      (r.inUnit === null || r.inUnit === (t.unitId !== null)),
  );
}

/**
 * The reporter to tell of what happens to the ticket, as a resident: a
 * resident ticket's reporter; nobody on a compound's work order, whose
 * reporter is the staff member who answers for it (the household of a
 * unit's field ticket hears of it through its visits, ADR 0034).
 */
export function residentReporter(
  t: Pick<Ticket, 'origin' | 'reporterId'>,
): string | null {
  return t.origin === 'resident' ? t.reporterId : null;
}

/** The reporter and creator as the resident side's parties, or none. */
export function residentParties(
  t: Pick<Ticket, 'origin' | 'reporterId' | 'createdById'>,
): string[] {
  return t.origin === 'resident' ? [t.reporterId, t.createdById] : [];
}

/**
 * The tickets an account is a resident party of (its personal-data export,
 * ADR 0036): those it created or reported as a resident. A work order's
 * staff reporter is never its party: the record is the compound's.
 */
export function residentPartyOf(accountId: string): Prisma.TicketWhereInput {
  return {
    AND: [
      RESIDENT_VISIBLE,
      { origin: 'resident' },
      { OR: [{ createdById: accountId }, { reporterId: accountId }] },
    ],
  };
}
