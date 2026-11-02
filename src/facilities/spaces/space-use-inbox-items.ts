import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { SpaceUsesService } from './space-uses.service';

/**
 * A common-area use request waiting for the staff (ADR 0084), in the staff
 * inbox (ADR 0073), for `bookings.handle`. Its approval takes no input: a
 * bulk approval may take it, through the requests' own approve (the
 * overlaps are checked there, under its locks).
 */
@Injectable()
export class SpaceUseInboxItems implements OnModuleInit {
  constructor(
    private readonly inbox: StaffInbox,
    private readonly uses: SpaceUsesService,
  ) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'space_use_request',
      permission: 'bookings.handle',
      dueHours: 24,
      page: async (tx, q) => {
        const rows = await tx.spaceUseRequest.findMany({
          where: {
            AND: [
              { status: 'pending' },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, status: true, unitId: true, createdAt: true },
        });
        return rows.map((r) => ({
          type: 'space_use_request' as const,
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
        tx.spaceUseRequest.count({
          where: {
            AND: [{ status: 'pending' }, ...waitingSince('createdAt', before)],
          },
        }),
      approve: async (id) => {
        await this.uses.approve(id);
      },
    });
  }
}
