import { Injectable } from '@nestjs/common';
import type { Booking, BookingSuspension } from '@prisma/client';
import { CommunityFacilitiesPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { FacilitiesAccess } from '../access';
import { dbNow } from '../db-clock';
import { BookingNotices } from '../notices/booking-notices';
import { FacilitySettingsService } from '../settings/facility-settings.service';

const DAY = 86_400_000;
const PAGE = keysetCursor('startsAt');

export interface StaffSuspension {
  suspension: BookingSuspension;
  unitCode: string;
}

export const suspensionNotFound = () =>
  appError.notFound(
    ErrorCode.BOOKING_SUSPENSION_NOT_FOUND,
    'Suspension not found',
  );

/** In force: not lifted and not over. */
export const inForce = (s: BookingSuspension, now: Date) =>
  s.liftedAt === null && s.endsAt.getTime() > now.getTime();

/**
 * A unit's suspension from booking (ADR 0044). The no-show that brings
 * the unit's no-shows to the compound's threshold within its window —
 * counting only those marked since the unit's last suspension began —
 * starts one for `suspensionDays`, unless one is in force; it is decided
 * under the unit's advisory lock, which a booking holds too, so a booking
 * is decided before it or after it, never across it. While in force the
 * unit makes no new booking; what it holds stays. The staff may lift one
 * with a reason code. The unit's people see it with its end.
 */
@Injectable()
export class SuspensionsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly community: CommunityFacilitiesPort,
    private readonly access: FacilitiesAccess,
    private readonly settings: FacilitySettingsService,
    private readonly notices: BookingNotices,
  ) {}

  /** The unit's suspension in force, if any; under the unit's lock to be sure of it. */
  current(
    tx: TenantTxClient,
    unitId: string,
    now: Date,
  ): Promise<BookingSuspension | null> {
    return tx.bookingSuspension.findFirst({
      where: { unitId, liftedAt: null, endsAt: { gt: now } },
      orderBy: [{ endsAt: 'desc' }, { id: 'asc' }],
    });
  }

  /**
   * After a no-show was marked, under the unit's lock: starts the unit's
   * suspension if its no-shows reached the threshold and none is in force.
   * Returns it, or null.
   */
  async afterNoShow(
    tx: TenantTxClient,
    booking: Booking,
    now: Date,
  ): Promise<BookingSuspension | null> {
    const rules = await this.settings.share(tx);
    if (await this.current(tx, booking.unitId, now)) return null;
    const last = await tx.bookingSuspension.findFirst({
      where: { unitId: booking.unitId },
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      select: { startsAt: true },
    });
    const windowStart = new Date(now.getTime() - rules.noShowWindowDays * DAY);
    const since =
      last && last.startsAt > windowStart ? last.startsAt : windowStart;
    const count = await tx.booking.count({
      where: {
        unitId: booking.unitId,
        status: 'no_show',
        noShowMarkedAt: { gt: since },
      },
    });
    if (count < rules.noShowThreshold) return null;
    const suspension = await tx.bookingSuspension.create({
      data: {
        id: newId(),
        tenantId: booking.tenantId,
        unitId: booking.unitId,
        startsAt: now,
        endsAt: new Date(now.getTime() + rules.suspensionDays * DAY),
        triggerBookingId: booking.id,
        noShowCount: count,
        createdAt: now,
      },
    });
    await this.audit.record(tx, {
      action: 'booking_suspension.started',
      targetId: suspension.id,
      metadata: {
        unitId: booking.unitId,
        triggerBookingId: booking.id,
        noShowCount: count,
        endsAt: suspension.endsAt.toISOString(),
      },
    });
    await this.notices.send(
      tx,
      await this.community.bookers(tx, booking.unitId),
      'booking_suspension.started',
      suspension.id,
    );
    return suspension;
  }

  /** The unit's suspension in force, for its people, and the clock it was read by. */
  standing(
    unitId: string,
  ): Promise<{ suspension: BookingSuspension | null; now: Date }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps?.unitView)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const now = await dbNow(tx);
      return { suspension: await this.current(tx, unitId, now), now };
    });
  }

  /** The compound's suspensions, latest first; `inForce` only those in force. */
  list(q: {
    inForce?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Page<StaffSuspension>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const limit = clampLimit(q.limit);
      const rows = await tx.bookingSuspension.findMany({
        where: {
          AND: [
            q.inForce ? { liftedAt: null, endsAt: { gt: now } } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const codes = await this.community.unitCodes(
        tx,
        page.items.map((s) => s.unitId),
      );
      return {
        items: page.items.map((suspension) => ({
          suspension,
          unitCode: codes.get(suspension.unitId) ?? '',
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** The staff lift a suspension in force, with a reason code. */
  lift(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.bookingSuspensionLift,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.bookingSuspension.findUnique({ where: { id } });
      if (!seen) throw suspensionNotFound();
      await this.access.lockUnit(tx, seen.unitId);
      const suspension = await tx.bookingSuspension.findUniqueOrThrow({
        where: { id },
      });
      const now = await dbNow(tx);
      if (!inForce(suspension, now))
        throw appError.conflict(
          ErrorCode.BOOKING_SUSPENSION_NOT_IN_FORCE,
          'This suspension is not in force',
        );
      await tx.bookingSuspension.update({
        where: { id },
        data: {
          liftedAt: now,
          liftedById: this.ctx.accountId,
          liftReasonCode: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'booking_suspension.lifted',
        targetId: id,
        metadata: { unitId: suspension.unitId, reasonCode: reason },
      });
    });
  }
}
