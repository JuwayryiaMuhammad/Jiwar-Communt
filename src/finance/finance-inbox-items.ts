import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../core/staff-inbox/staff-inbox';
import { show } from './money';

/**
 * Finance's items in the staff inbox (ADR 0073): a resident's request for a
 * payment plan (ADR 0069) and an invoice dispute (ADR 0048), both for
 * `finance.invoice` holders. A plan's amount is its invoice's total, held to
 * `payment_plan_above_limit`; a dispute's credit is chosen at the decision,
 * so it shows `waiver_above_limit`'s limit with no amount. Both are decided
 * with input on their own routes.
 */
@Injectable()
export class FinanceInboxItems implements OnModuleInit {
  constructor(private readonly inbox: StaffInbox) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'plan_request',
      permission: 'finance.invoice',
      dueHours: 72,
      threshold: 'payment_plan_above_limit',
      page: async (tx, q) => {
        const rows = await tx.instalmentPlanRequest.findMany({
          where: {
            AND: [
              { status: 'pending' },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: {
            id: true,
            status: true,
            unitId: true,
            invoiceId: true,
            createdAt: true,
          },
        });
        const totals = new Map(
          (
            await tx.invoice.findMany({
              where: { id: { in: rows.map((r) => r.invoiceId) } },
              select: { id: true, total: true },
            })
          ).map((i) => [i.id, i.total]),
        );
        return rows.map((r) => {
          const total = totals.get(r.invoiceId);
          return {
            type: 'plan_request' as const,
            id: r.id,
            number: null,
            kind: null,
            status: r.status,
            unitId: r.unitId,
            requestedAt: r.createdAt,
            amount: total ? show(total) : null,
          };
        });
      },
      count: (tx, before) =>
        tx.instalmentPlanRequest.count({
          where: {
            AND: [{ status: 'pending' }, ...waitingSince('createdAt', before)],
          },
        }),
    });
    this.inbox.register({
      type: 'invoice_dispute',
      permission: 'finance.invoice',
      dueHours: 120,
      threshold: 'waiver_above_limit',
      page: async (tx, q) => {
        const rows = await tx.invoiceDispute.findMany({
          where: {
            AND: [
              { status: 'open' },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, status: true, unitId: true, createdAt: true },
        });
        return rows.map((r) => ({
          type: 'invoice_dispute' as const,
          id: r.id,
          number: null,
          kind: null,
          status: r.status,
          unitId: r.unitId,
          requestedAt: r.createdAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.invoiceDispute.count({
          where: {
            AND: [{ status: 'open' }, ...waitingSince('createdAt', before)],
          },
        }),
    });
  }
}
