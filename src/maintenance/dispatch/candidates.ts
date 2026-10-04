import type { Prisma, Ticket } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * Who can take a queued ticket (ADR 0033): an active staff account that
 * holds `tickets.work`, is `available` (no availability row is not), has an
 * active specialty that can handle the category (or any, when the category
 * has none), and **never declined this ticket**, in any cycle.
 *
 * Specialties that are retired are ignored on both sides: a category whose
 * specialties are all retired behaves as a category with none.
 */
export async function candidateFilter(
  tx: TenantTxClient,
  ticket: Pick<Ticket, 'id' | 'categoryId'>,
): Promise<Prisma.AccountWhereInput> {
  const required = (
    await tx.categorySpecialty.findMany({
      where: { categoryId: ticket.categoryId, specialty: { active: true } },
      select: { specialtyId: true },
    })
  ).map((r) => r.specialtyId);
  const decliners = (
    await tx.ticketAssignment.findMany({
      where: { ticketId: ticket.id, assignmentType: 'declined' },
      select: { fromId: true },
    })
  ).flatMap((r) => (r.fromId ? [r.fromId] : []));
  return {
    status: 'active',
    type: 'staff',
    role: { permissions: { some: { permission: 'tickets.work' } } },
    availability: { is: { state: 'available' } },
    ...(required.length
      ? {
          technicianSpecialties: {
            some: { active: true, specialtyId: { in: required } },
          },
        }
      : {}),
    ...(decliners.length ? { id: { notIn: decliners } } : {}),
  };
}

/** The candidates, by id. */
export async function candidatesFor(
  tx: TenantTxClient,
  ticket: Pick<Ticket, 'id' | 'categoryId'>,
): Promise<string[]> {
  const rows = await tx.account.findMany({
    where: await candidateFilter(tx, ticket),
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => r.id);
}
