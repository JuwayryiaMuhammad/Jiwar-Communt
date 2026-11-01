import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { StaffBookingsService } from './staff-bookings.service';

/**
 * A booking of a facility that requires approval, waiting for the staff
 * (ADR 0044), in the staff inbox (ADR 0073). Its approval takes no input:
 * a bulk approval may take it, through the bookings' own approve (the
 * slot's capacity and window are checked there).
 */
@Injectable()
export class BookingInboxItems implements OnModuleInit {
  constructor(
    private readonly inbox: StaffInbox,
    private readonly bookings: StaffBookingsService,
  ) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'booking',
      permission: 'bookings.handle',
      dueHours: 24,
      page: async (tx, q) => {
        const rows = await tx.booking.findMany({
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
          type: 'booking' as const,
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
        tx.booking.count({
          where: {
            AND: [{ status: 'pending' }, ...waitingSince('createdAt', before)],
          },
        }),
      approve: (id) => this.bookings.approve(id),
    });
  }
}
