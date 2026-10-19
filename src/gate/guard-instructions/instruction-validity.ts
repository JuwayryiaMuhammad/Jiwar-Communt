import type { Prisma } from '@prisma/client';

/** Where an instruction stands on a compound day (ADR 0056). */
export const INSTRUCTION_STATES = [
  'scheduled',
  'live',
  'expired',
  'archived',
] as const;
export type InstructionState = (typeof INSTRUCTION_STATES)[number];

export interface Validity {
  validFrom: Date | null;
  validUntil: Date | null;
}

/** A DATE column's day, `YYYY-MM-DD`. */
export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** A compound day as a DATE column takes it. */
export const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** Whether it holds on `day`: from and until both inclusive, either open. */
export function validOn(i: Validity, day: string): boolean {
  return (
    (!i.validFrom || dayOf(i.validFrom) <= day) &&
    (!i.validUntil || dayOf(i.validUntil) >= day)
  );
}

export function instructionState(
  i: Validity & { archivedAt: Date | null },
  day: string,
): InstructionState {
  if (i.archivedAt) return 'archived';
  if (i.validFrom && dayOf(i.validFrom) > day) return 'scheduled';
  if (i.validUntil && dayOf(i.validUntil) < day) return 'expired';
  return 'live';
}

/** The same as a query: the instructions valid on `day`. */
export function validOnWhere(day: string): Prisma.GuardInstructionWhereInput {
  const d = dateOf(day);
  return {
    AND: [
      { OR: [{ validFrom: null }, { validFrom: { lte: d } }] },
      { OR: [{ validUntil: null }, { validUntil: { gte: d } }] },
    ],
  };
}

/** The instructions in a state on `day`, as a query. */
export function stateWhere(
  state: InstructionState,
  day: string,
): Prisma.GuardInstructionWhereInput {
  const d = dateOf(day);
  switch (state) {
    case 'archived':
      return { archivedAt: { not: null } };
    case 'scheduled':
      return { archivedAt: null, validFrom: { gt: d } };
    case 'expired':
      return { archivedAt: null, validUntil: { lt: d } };
    case 'live':
      return { archivedAt: null, ...validOnWhere(day) };
  }
}
