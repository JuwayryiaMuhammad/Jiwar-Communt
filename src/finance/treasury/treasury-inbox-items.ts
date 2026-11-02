import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
  type InboxCursor,
} from '../../core/staff-inbox/staff-inbox';
import { formatNumber } from '../counters';
import { OPEN_CUSTODY } from './custody.service';

/**
 * The treasury's items in the staff inbox (ADR 0073, 0085):
 * - `cash_custody`, for `finance.payments`: a custodian's cash not handed
 *   in, one item a custodian, waiting since their oldest open payment (the
 *   item's id: a hand-in makes the next payment the item, so its overdue
 *   notice is told once per custody, not once per person ever);
 * - `custody_variance`, for `finance.custody`: a hand-in's variance not
 *   yet settled.
 * Both are decided on their own routes, never in bulk.
 */
@Injectable()
export class TreasuryInboxItems implements OnModuleInit {
  constructor(private readonly inbox: StaffInbox) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'cash_custody',
      permission: 'finance.payments',
      dueHours: 24,
      page: async (tx, q) => {
        const rows = await tx.$queryRaw<
          { id: string; receipt_number: number; created_at: Date }[]
        >`
          SELECT * FROM (
            SELECT DISTINCT ON (p.recorded_by_account_id) p.id, p.receipt_number, p.created_at
              FROM finance_payments p WHERE ${OPEN_CUSTODY}
             ORDER BY p.recorded_by_account_id, p.created_at, p.id
          ) o
           WHERE ${before(q.requestedBefore)} AND ${after(q.after)}
           ORDER BY o.created_at, o.id LIMIT ${q.take}`;
        return rows.map((r) => ({
          type: 'cash_custody' as const,
          id: r.id,
          number: formatNumber('receipt', r.receipt_number),
          kind: null,
          status: 'open',
          unitId: null,
          requestedAt: r.created_at,
          amount: null,
        }));
      },
      count: async (tx, requestedBefore) => {
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM (
            SELECT p.recorded_by_account_id, MIN(p.created_at) AS created_at
              FROM finance_payments p WHERE ${OPEN_CUSTODY}
             GROUP BY p.recorded_by_account_id
          ) o WHERE ${before(requestedBefore)}`;
        return n;
      },
    });
    this.inbox.register({
      type: 'custody_variance',
      permission: 'finance.custody',
      dueHours: 72,
      page: async (tx, q) => {
        const rows = await tx.financeCustodyHandin.findMany({
          where: {
            AND: [
              { status: 'variance' },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, number: true, status: true, createdAt: true },
        });
        return rows.map((r) => ({
          type: 'custody_variance' as const,
          id: r.id,
          number: formatNumber('handin', r.number),
          kind: null,
          status: r.status,
          unitId: null,
          requestedAt: r.createdAt,
          amount: null,
        }));
      },
      count: (tx, requestedBefore) =>
        tx.financeCustodyHandin.count({
          where: {
            AND: [
              { status: 'variance' },
              ...waitingSince('createdAt', requestedBefore),
            ],
          },
        }),
    });
  }
}

const before = (at: Date | null) =>
  at ? Prisma.sql`o.created_at < ${at}` : Prisma.sql`TRUE`;
const after = (c: InboxCursor | null) =>
  c
    ? Prisma.sql`(o.created_at > ${c.at} OR (o.created_at = ${c.at} AND o.id > ${c.id}::uuid))`
    : Prisma.sql`TRUE`;
