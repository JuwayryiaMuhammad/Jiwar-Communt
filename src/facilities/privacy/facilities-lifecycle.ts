import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityFacilitiesPort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { HOLDING } from '../bookings/booking-rules';
import { BookingsService } from '../bookings/bookings.service';
import { dbNow } from '../db-clock';

/**
 * What happens to an account's bookings when it goes (ADR 0044), in the
 * transaction of what made it go, which holds the account's row:
 *
 * - deactivated, or erased (an erasure deactivates the account first,
 *   inside it): its bookings that have not started are cancelled by the
 *   system (`booker_left`) and give their places back; every booking
 *   stays, pointing at the tombstone once erased;
 * - its residence changed: on each unit it no longer may book for, its
 *   bookings there that have not started are cancelled, `booker_left`.
 *   (A member who only loses the household's `bookings` grant keeps what
 *   it booked: no hook fires, and the grant is checked at each booking.)
 *
 * Nobody is told: the booker is gone. No unit or facility lock: a
 * cancellation only frees places and quota, so it can wait on nothing a
 * booking holds; the bookings themselves are locked in id order.
 * Coverage of a club membership needs nothing: it holds only while the
 * occupancy or the household membership is active.
 */
@Injectable()
export class FacilitiesLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityFacilitiesPort,
    private readonly bookings: BookingsService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onErasing(async (tx, account) => {
      // Community's erasure deactivates the account first, which cancelled
      // these already; this catches anything booked by a handler order
      // that differs.
      await this.cancelFuture(tx, account.id, 'booker_left');
      return [];
    });
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.cancelFuture(tx, account.id, 'booker_left');
      return [];
    });
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      const units = await tx.booking.findMany({
        where: {
          bookedById: account.id,
          status: { in: [...HOLDING] },
          startsAt: { gt: await dbNow(tx) },
        },
        distinct: ['unitId'],
        select: { unitId: true },
      });
      for (const { unitId } of units) {
        const caps = await this.community.placeIn(tx, account.id, unitId);
        if (!caps?.bookings)
          await this.cancelFuture(tx, account.id, 'booker_left', unitId);
      }
    });
  }

  /** The account's bookings that have not started, cancelled by the system. */
  private async cancelFuture(
    tx: TenantTxClient,
    accountId: string,
    reason: 'booker_left',
    unitId?: string,
  ): Promise<void> {
    const now = await dbNow(tx);
    const ids = unitId
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM bookings
           WHERE booked_by_account_id = ${accountId}::uuid AND unit_id = ${unitId}::uuid
             AND status::text = ANY(${[...HOLDING]}::text[]) AND starts_at > ${now}
           ORDER BY id FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM bookings
           WHERE booked_by_account_id = ${accountId}::uuid
             AND status::text = ANY(${[...HOLDING]}::text[]) AND starts_at > ${now}
           ORDER BY id FOR UPDATE`;
    for (const { id } of ids) {
      const booking = await tx.booking.findUniqueOrThrow({ where: { id } });
      await this.bookings.end(tx, booking, {
        side: 'system',
        reason,
        by: null,
        now,
      });
    }
  }
}
