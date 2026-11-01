import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../core/staff-inbox/staff-inbox';
import { decisionAppealReference } from './decision-appeals/appeal-rules';
import { requestNumber } from './requests/request-rules';

/**
 * The management's items in the staff inbox (ADR 0073): a request a
 * resident sent the office, open or in progress (ADR 0039; one answered
 * waits for the resident), and a staff decision appealed to the management
 * (ADR 0059). Both are answered with words or a reason on their own routes.
 */
@Injectable()
export class ManagementInboxItems implements OnModuleInit {
  constructor(private readonly inbox: StaffInbox) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'management_request',
      permission: 'requests.handle',
      dueHours: 72,
      page: async (tx, q) => {
        const rows = await tx.managementRequest.findMany({
          where: {
            AND: [
              { status: { in: ['open', 'in_progress'] } },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            type: true,
            status: true,
            unitId: true,
            createdAt: true,
          },
        });
        return rows.map((r) => ({
          type: 'management_request' as const,
          id: r.id,
          number: requestNumber(r.number),
          kind: r.type,
          status: r.status,
          unitId: r.unitId,
          requestedAt: r.createdAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.managementRequest.count({
          where: {
            AND: [
              { status: { in: ['open', 'in_progress'] } },
              ...waitingSince('createdAt', before),
            ],
          },
        }),
    });
    this.inbox.register({
      type: 'decision_appeal',
      permission: 'appeals.decide',
      dueHours: 120,
      page: async (tx, q) => {
        const rows = await tx.decisionAppeal.findMany({
          where: {
            AND: [
              { status: 'pending' },
              ...waitingSince('lodgedAt', q.requestedBefore),
              ...afterCursor('lodgedAt', q.after),
            ],
          },
          orderBy: [{ lodgedAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            kind: true,
            status: true,
            unitId: true,
            lodgedAt: true,
          },
        });
        return rows.map((r) => ({
          type: 'decision_appeal' as const,
          id: r.id,
          number: decisionAppealReference(r.number),
          kind: r.kind,
          status: r.status,
          unitId: r.unitId,
          requestedAt: r.lodgedAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.decisionAppeal.count({
          where: {
            AND: [{ status: 'pending' }, ...waitingSince('lodgedAt', before)],
          },
        }),
    });
  }
}
