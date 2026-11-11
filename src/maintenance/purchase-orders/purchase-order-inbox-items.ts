import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { orderReference } from './purchase-order-rules';

/**
 * A purchase order, or a revision of one, waiting for its approver, in the
 * staff inbox (ADR 0073, 0094): seen by `purchases.approve`, with its total
 * against the major contract threshold. Decided on its own routes: an
 * approval may name the board's approval, so it is not approved in bulk.
 */
@Injectable()
export class PurchaseOrderInboxItems implements OnModuleInit {
  constructor(private readonly inbox: StaffInbox) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'purchase_order',
      permission: 'purchases.approve',
      dueHours: 72,
      threshold: 'major_contract',
      page: async (tx, q) => {
        const rows = await tx.purchaseOrderRevision.findMany({
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
            purchaseOrderId: true,
            requestedAt: true,
            total: true,
          },
        });
        const orders = await tx.purchaseOrder.findMany({
          where: { id: { in: rows.map((r) => r.purchaseOrderId) } },
          select: { id: true, number: true, status: true },
        });
        const byId = new Map(orders.map((o) => [o.id, o]));
        return rows.map((r) => {
          const o = byId.get(r.purchaseOrderId)!;
          return {
            type: 'purchase_order' as const,
            // The revision's id (the keyset runs on it); the page lists the waiting.
            id: r.id,
            number: orderReference(o.number),
            kind: null,
            status: o.status,
            unitId: null,
            requestedAt: r.requestedAt,
            amount: r.total.toFixed(2),
          };
        });
      },
      count: (tx, before) =>
        tx.purchaseOrderRevision.count({
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
