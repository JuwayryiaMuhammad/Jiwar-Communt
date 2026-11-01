import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { WorkPermitsService } from './work-permits.service';

/**
 * A technician's work permit waiting for safety's approval (ADR 0067), in
 * the staff inbox (ADR 0073). It expires on its own; its approval takes no
 * input, so a bulk approval may take it, through the permits' own approve.
 */
@Injectable()
export class WorkPermitInboxItems implements OnModuleInit {
  constructor(
    private readonly inbox: StaffInbox,
    private readonly permits: WorkPermitsService,
  ) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'work_permit',
      permission: 'safety.manage',
      dueHours: 2,
      page: async (tx, q) => {
        const rows = await tx.workPermit.findMany({
          where: {
            AND: [
              { status: 'requested' },
              ...waitingSince('requestedAt', q.requestedBefore),
              ...afterCursor('requestedAt', q.after),
            ],
          },
          orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, hazard: true, status: true, requestedAt: true },
        });
        return rows.map((r) => ({
          type: 'work_permit' as const,
          id: r.id,
          number: null,
          kind: r.hazard,
          status: r.status,
          unitId: null,
          requestedAt: r.requestedAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.workPermit.count({
          where: {
            AND: [
              { status: 'requested' },
              ...waitingSince('requestedAt', before),
            ],
          },
        }),
      approve: async (id) => {
        await this.permits.approve(id);
      },
    });
  }
}
