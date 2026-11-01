import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';

/**
 * The community's items in the staff inbox (ADR 0073): a self-registration
 * waiting for the management (ADR 0024; one sent back for a correction
 * waits for the registrant, not the staff) and a household worker waiting
 * for review (ADR 0017). Both are decided with input on their own routes.
 */
@Injectable()
export class CommunityInboxItems implements OnModuleInit {
  constructor(private readonly inbox: StaffInbox) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'registration',
      permission: 'residents.manage',
      dueHours: 72,
      page: async (tx, q) => {
        const rows = await tx.residentRegistration.findMany({
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
            occupancyType: true,
            status: true,
            createdAt: true,
          },
        });
        return rows.map((r) => ({
          type: 'registration' as const,
          id: r.id,
          number: null,
          kind: r.occupancyType,
          status: r.status,
          unitId: null,
          requestedAt: r.createdAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.residentRegistration.count({
          where: {
            AND: [{ status: 'pending' }, ...waitingSince('createdAt', before)],
          },
        }),
    });
    this.inbox.register({
      type: 'worker_engagement',
      permission: 'workers.review',
      dueHours: 48,
      page: async (tx, q) => {
        const rows = await tx.workerEngagement.findMany({
          where: {
            AND: [
              { status: 'pending_review' },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, status: true, unitId: true, createdAt: true },
        });
        return rows.map((r) => ({
          type: 'worker_engagement' as const,
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
        tx.workerEngagement.count({
          where: {
            AND: [
              { status: 'pending_review' },
              ...waitingSince('createdAt', before),
            ],
          },
        }),
    });
  }
}
