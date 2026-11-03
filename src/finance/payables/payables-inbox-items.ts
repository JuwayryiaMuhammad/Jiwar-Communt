import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { formatNumber } from '../counters';

/**
 * A vendor's invoice, an advance and a retention's release waiting for
 * their approver, in the staff inbox (ADR 0073, 0089): seen by
 * `finance.payables_approve`, each with its amount against the major
 * contract threshold. Decided on their own routes, never in bulk: an
 * approval names a budget line and may need the board's authorization.
 */
@Injectable()
export class PayablesInboxItems implements OnModuleInit {
  constructor(private readonly inbox: StaffInbox) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'vendor_invoice',
      permission: 'finance.payables_approve',
      dueHours: 72,
      threshold: 'major_contract',
      page: async (tx, q) => {
        const rows = await tx.financeVendorInvoice.findMany({
          where: {
            AND: [
              { status: 'received' },
              ...waitingSince('recordedAt', q.requestedBefore),
              ...afterCursor('recordedAt', q.after),
            ],
          },
          orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            status: true,
            recordedAt: true,
            total: true,
          },
        });
        return rows.map((r) => ({
          type: 'vendor_invoice' as const,
          id: r.id,
          number: formatNumber('vendor_invoice', r.number),
          kind: null,
          status: r.status,
          unitId: null,
          requestedAt: r.recordedAt,
          amount: r.total.toFixed(2),
        }));
      },
      count: (tx, before) =>
        tx.financeVendorInvoice.count({
          where: {
            AND: [
              { status: 'received' },
              ...waitingSince('recordedAt', before),
            ],
          },
        }),
    });
    this.inbox.register({
      type: 'contract_disbursement',
      permission: 'finance.payables_approve',
      dueHours: 72,
      threshold: 'major_contract',
      page: async (tx, q) => {
        const rows = await tx.financeContractDisbursement.findMany({
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
            kind: true,
            status: true,
            requestedAt: true,
            amount: true,
          },
        });
        return rows.map((r) => ({
          type: 'contract_disbursement' as const,
          id: r.id,
          number: formatNumber('disbursement', r.number),
          kind: r.kind,
          status: r.status,
          unitId: null,
          requestedAt: r.requestedAt,
          amount: r.amount.toFixed(2),
        }));
      },
      count: (tx, before) =>
        tx.financeContractDisbursement.count({
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
