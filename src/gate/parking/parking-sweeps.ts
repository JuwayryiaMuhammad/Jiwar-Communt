import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { VISITOR_NAME_RETENTION_DAYS } from './parking-rules';

export const VISITOR_NAMES_SWEEP = 'parking.visitor_names';

const BATCH = 500;
const DAY = 86_400_000;

/**
 * A visitor's name on a parking booking goes 30 days after the booking
 * ends (ADR 0045), as a pass's visitor data does (ADR 0028): the booking
 * stays, its name null and `visitor_name_cleared_at` set. One conditional
 * update per compound: idempotent, safe on several instances, and run for
 * a suspended compound too.
 */
@Injectable()
export class ParkingSweeps implements OnModuleInit {
  constructor(private readonly sweep: SweepRunner) {}

  onModuleInit(): void {
    this.sweep.register(VISITOR_NAMES_SWEEP, (now) => this.forget(now));
  }

  /** Names deleted. */
  forget(now: Date): Promise<number> {
    const due = new Date(now.getTime() - VISITOR_NAME_RETENTION_DAYS * DAY);
    return this.sweep.forEachTenantItem(
      () => Promise.resolve([true]),
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          UPDATE visitor_parking_bookings
             SET visitor_name = NULL, visitor_name_cleared_at = ${now}
           WHERE id IN (
             SELECT id FROM visitor_parking_bookings
              WHERE visitor_name IS NOT NULL AND ends_at <= ${due}
              ORDER BY ends_at LIMIT ${BATCH}
              FOR UPDATE SKIP LOCKED)
          RETURNING id`;
        return rows.length;
      },
    );
  }
}
