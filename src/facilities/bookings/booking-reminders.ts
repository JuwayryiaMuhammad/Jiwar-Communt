import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { BookingNotices } from '../notices/booking-notices';

export const BOOKING_REMINDER_SWEEP = 'bookings.reminder';
/** A booking is reminded about two hours before it starts… */
export const REMINDER_LEAD_MS = 2 * 3_600_000;
const BATCH = 500;

/**
 * The reminder before a booking (ADR 0044): a confirmed booking is
 * reminded to its booker once, in the two hours before its start — if it
 * was made at least two hours before (one made at the last minute needs no
 * reminder). Every minute; one booking per transaction. "Once" is
 * `reminded_at`, claimed with a conditional update: of two sweeps at once,
 * one claims it and the other changes nothing and tells nobody.
 */
@Injectable()
export class BookingReminders implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly notices: BookingNotices,
  ) {}

  onModuleInit(): void {
    this.sweep.register(BOOKING_REMINDER_SWEEP, (now) => this.remind(now), {
      intervalMs: 60_000,
    });
  }

  /** Reminders sent. */
  remind(now: Date): Promise<number> {
    const until = new Date(now.getTime() + REMINDER_LEAD_MS);
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        if (!(await this.active(tx, tenantId))) return [];
        const due = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM bookings
           WHERE status = 'confirmed' AND reminded_at IS NULL
             AND starts_at > ${now} AND starts_at <= ${until}
             AND created_at <= starts_at - interval '2 hours'
           ORDER BY starts_at, id LIMIT ${BATCH}`;
        return due.map((b) => b.id);
      },
      async (tx, _tenantId, id) => {
        const { count } = await tx.booking.updateMany({
          where: {
            id,
            status: 'confirmed',
            remindedAt: null,
            startsAt: { gt: now, lte: until },
          },
          data: { remindedAt: now },
        });
        if (!count) return 0;
        const booking = await tx.booking.findUniqueOrThrow({ where: { id } });
        await this.notices.send(
          tx,
          [booking.bookedById],
          'booking.reminder',
          id,
        );
        return 1;
      },
    );
  }

  private async active(tx: TenantTxClient, tenantId: string): Promise<boolean> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return tenant?.status === 'active';
  }
}
