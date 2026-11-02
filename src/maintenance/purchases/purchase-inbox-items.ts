import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { purchaseReference } from './purchase-rules';

/**
 * A purchase request waiting for its approver, in the staff inbox (ADR 0073,
 * 0077): seen by `purchases.approve`, with its amount against the major
 * contract threshold. Decided on its own routes: an approval may name the
 * board's approval, so it is not approved in bulk.
 */
@Injectable()
export class PurchaseInboxItems implements OnModuleInit {
  constructor(private readonly inbox: StaffInbox) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'purchase_request',
      permission: 'purchases.approve',
      dueHours: 72,
      threshold: 'major_contract',
      page: async (tx, q) => {
        const rows = await tx.purchaseRequest.findMany({
          where: {
            AND: [
              { status: 'requested' },
              ...waitingSince('requestedAt', q.requestedBefore),
              ...afterCursor('requestedAt', q.after),
            ],
          },
          orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            status: true,
            requestedAt: true,
            estimatedAmount: true,
          },
        });
        return rows.map((r) => ({
          type: 'purchase_request' as const,
          id: r.id,
          number: purchaseReference(r.number),
          kind: null,
          status: r.status,
          unitId: null,
          requestedAt: r.requestedAt,
          amount: r.estimatedAmount.toFixed(2),
        }));
      },
      count: (tx, before) =>
        tx.purchaseRequest.count({
          where: {
            AND: [
              { status: 'requested' },
              ...waitingSince('requestedAt', before),
            ],
          },
        }),
    });
  }
}
