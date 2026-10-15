import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  Prisma,
  UnitParkingSlot,
  VisitorParkingArea,
  VisitorParkingBooking,
  VisitorPass,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { unitNotFound, VehicleCore } from '../vehicles/vehicle-core';
import {
  DAYS_AHEAD,
  EARLIEST_MINUTES,
  freeSpaces,
  MIN_MINUTES,
  peakOverlap,
  VISITOR_NAME,
} from './parking-rules';
import { VisitorParkingBookingView } from './views/parking.views';

export const VISITOR_PARKING_RESOURCE = 'visitor_parking_booking';

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface NewVisitorParking {
  areaId: string;
  visitorPassId?: string | null;
  visitorName?: string;
  startsAt: string;
  endsAt: string;
}

/** A booking as a resident sees it, assembled in the read's transaction. */
export interface ResidentParking {
  booking: VisitorParkingBooking;
  areaName: string;
  /** The caller made it: the visitor's name is theirs to see. */
  mine: boolean;
}

export interface UnitParking {
  slots: UnitParkingSlot[];
  areas: { area: VisitorParkingArea; freeSpaces: number }[];
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const bookingNotFound = () =>
  appError.notFound(
    ErrorCode.VISITOR_PARKING_BOOKING_NOT_FOUND,
    'Visitor parking booking not found',
  );

/** Upcoming: soonest first. Past (ended or cancelled): latest first. */
const UPCOMING = keysetCursor('startsAt', 'asc');
const PAST = keysetCursor('startsAt', 'desc');

/**
 * Visitor parking for the unit's people (ADR 0045). Whoever may invite
 * visitors to the unit books one space of an area for a window, for one of
 * the unit's passes they manage or for a visitor's name. A space is never
 * given twice: a booking takes the area's row and counts, under it, the
 * most bookings that hold one instant of its window (`peakOverlap`).
 *
 * Lock order: the caller's account, the unit's parking lock, the pass's
 * row (FOR SHARE: its cancellation waits), the area's row, the counter.
 */
@Injectable()
export class VisitorParkingService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityGatePort,
    private readonly core: VehicleCore,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(VISITOR_PARKING_RESOURCE, async (id) =>
      VisitorParkingBookingView.from(await this.get(id)),
    );
  }

  /** The unit's slots, and each active visitor area with its free spaces now. */
  unitParking(unitId: string): Promise<UnitParking> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        unitId,
      );
      if (!caps?.unitView) throw unitNotFound();
      const slots = await tx.unitParkingSlot.findMany({
        where: { unitId },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
      });
      const areas = await tx.visitorParkingArea.findMany({
        where: { active: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      const now = await dbNow(tx);
      const holding = areas.length
        ? await tx.visitorParkingBooking.findMany({
            where: {
              areaId: { in: areas.map((a) => a.id) },
              status: 'confirmed',
              startsAt: { lte: now },
              endsAt: { gt: now },
            },
            select: { areaId: true, startsAt: true, endsAt: true },
          })
        : [];
      return {
        slots,
        areas: areas.map((area) => ({
          area,
          freeSpaces: freeSpaces(
            area.capacity,
            holding.filter((b) => b.areaId === area.id),
            now,
          ),
        })),
      };
    });
  }

  /** The unit's bookings: the primary sees every one, others their own. */
  list(
    unitId: string,
    q: { status?: 'upcoming' | 'past'; cursor?: string; limit?: number },
  ): Promise<Page<ResidentParking>> {
    const limit = clampLimit(q.limit);
    const page = q.status === 'past' ? PAST : UPCOMING;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requireInviter(tx, unitId);
      const me = this.ctx.accountId;
      const all = await this.community.isPrimary(tx, unitId, me);
      const now = await dbNow(tx);
      const when: Prisma.VisitorParkingBookingWhereInput =
        q.status === 'past'
          ? { OR: [{ status: 'cancelled' }, { endsAt: { lte: now } }] }
          : { status: 'confirmed', endsAt: { gt: now } };
      const rows = await tx.visitorParkingBooking.findMany({
        where: {
          AND: [
            { unitId, ...(all ? {} : { bookedById: me }) },
            when,
            ...(page.after(q.cursor) as Prisma.VisitorParkingBookingWhereInput[]),
          ],
        },
        include: { area: { select: { name: true } } },
        orderBy: page.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = page.toPage(rows, limit);
      return {
        nextCursor,
        items: items.map((b) => ({
          booking: b,
          areaName: b.area.name,
          mine: b.bookedById === me,
        })),
      };
    });
  }

  get(id: string): Promise<ResidentParking> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const booking = await this.visible(tx, id);
      const area = await tx.visitorParkingArea.findUniqueOrThrow({
        where: { id: booking.areaId },
      });
      return {
        booking,
        areaName: area.name,
        mine: booking.bookedById === this.ctx.accountId,
      };
    });
  }

  /**
   * Books one space of an area for a visitor: for a pass of the unit the
   * caller manages (its host or the unit's primary), active, the window
   * inside its validity; or for a visitor's name. Whole minutes, at least
   * 15, at most the compound's `visitorParkingMaxHours`, starting no
   * earlier than 15 minutes ago and at most 14 days ahead. At most the
   * compound's `maxActiveVisitorParkingBookings` per unit not yet ended.
   */
  book(unitId: string, input: NewVisitorParking): Promise<ResidentParking> {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const passId = input.visitorPassId ?? null;
    const fields: FieldError[] = [];
    for (const [field, at] of [
      ['startsAt', startsAt],
      ['endsAt', endsAt],
    ] as const)
      if (at.getTime() % MINUTE !== 0)
        fields.push({ field, code: FieldErrorCode.INVALID_FORMAT });
    if (endsAt <= startsAt)
      fields.push({ field: 'endsAt', code: FieldErrorCode.ENDS_BEFORE_START });
    let visitorName: string | null = null;
    if (passId) {
      if (input.visitorName !== undefined)
        fields.push({
          field: 'visitorName',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    } else {
      visitorName = (input.visitorName ?? '').trim().replace(/\s+/g, ' ');
      if (!visitorName)
        fields.push({
          field: 'visitorName',
          code: FieldErrorCode.FIELD_REQUIRED,
        });
      else if (visitorName.length > VISITOR_NAME.max)
        fields.push({
          field: 'visitorName',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { ...VISITOR_NAME },
        });
    }
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: VISITOR_PARKING_RESOURCE, id });
      await this.core.lockSelf(tx);
      await this.requireInviter(tx, unitId);
      await this.lockUnitParking(tx, unitId);
      const settings = await this.core.settings(tx);
      const now = await dbNow(tx);
      this.checkWindow(startsAt, endsAt, now, settings.visitorParkingMaxHours);
      const active = await tx.visitorParkingBooking.count({
        where: { unitId, status: 'confirmed', endsAt: { gt: now } },
      });
      const max = settings.maxActiveVisitorParkingBookings;
      if (active >= max)
        throw appError.conflict(
          ErrorCode.VISITOR_PARKING_LIMIT_REACHED,
          'The unit holds as many visitor parking bookings as the compound allows',
          { params: { max } },
        );
      if (passId) await this.checkPass(tx, unitId, passId, startsAt, endsAt, now);
      const area = await this.lockArea(tx, input.areaId);
      if (!area?.active)
        throw invalid([
          { field: 'areaId', code: FieldErrorCode.AREA_NOT_AVAILABLE },
        ]);
      const holding = await tx.visitorParkingBooking.findMany({
        where: {
          areaId: area.id,
          status: 'confirmed',
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
        select: { startsAt: true, endsAt: true },
      });
      if (peakOverlap(holding, startsAt, endsAt) + 1 > area.capacity)
        throw appError.conflict(
          ErrorCode.VISITOR_PARKING_FULL,
          'The area has no space left for that window',
        );
      const number = await this.core.nextNumber(tx, 'parking_booking');
      const booking = await tx.visitorParkingBooking.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          unitId,
          areaId: area.id,
          visitorPassId: passId,
          visitorName,
          startsAt,
          endsAt,
          bookedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'visitor_parking_booking.created',
        targetId: id,
        metadata: {
          unitId,
          areaId: area.id,
          visitorPassId: passId,
          number,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
      });
      return { booking, areaName: area.name, mine: true };
    });
  }

  /** Its booker or the unit's primary cancels a booking, until it ends. */
  cancel(unitId: string, id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const seen = await this.visible(tx, id);
      if (seen.unitId !== unitId) throw bookingNotFound();
      const booking = await this.lockRow(tx, id);
      const now = await dbNow(tx);
      checkCancellable(booking, now);
      await this.end(tx, booking, {
        side: 'resident',
        reason: 'no_longer_needed',
        by: this.ctx.accountId,
        now,
      });
    });
  }

  /**
   * A pass was cancelled (by its host, the system, or the visitor's "not
   * me"): its bookings not yet ended are cancelled by the system, in the
   * pass's transaction, which holds the pass's row. Nobody is told: the one
   * who cancelled the pass knows.
   */
  async cancelForPass(tx: TenantTxClient, passId: string): Promise<void> {
    const now = await dbNow(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM visitor_parking_bookings
       WHERE visitor_pass_id = ${passId}::uuid AND status = 'confirmed'
         AND ends_at > ${now}
       ORDER BY id FOR UPDATE`;
    for (const { id } of rows) {
      const booking = await tx.visitorParkingBooking.findUniqueOrThrow({
        where: { id },
      });
      await this.end(tx, booking, {
        side: 'system',
        reason: 'pass_cancelled',
        by: null,
        now,
      });
    }
  }

  /** Cancels a confirmed booking under its row lock, audited. */
  async end(
    tx: TenantTxClient,
    booking: VisitorParkingBooking,
    how: {
      side: 'resident' | 'staff' | 'system';
      reason: string;
      by: string | null;
      now: Date;
    },
  ): Promise<void> {
    await tx.visitorParkingBooking.update({
      where: { id: booking.id },
      data: {
        status: 'cancelled',
        cancelledAt: how.now,
        cancelledById: how.by,
        cancelSide: how.side,
        cancelReason: how.reason,
      },
    });
    await this.audit.record(tx, {
      action: 'visitor_parking_booking.cancelled',
      targetId: booking.id,
      metadata: {
        unitId: booking.unitId,
        areaId: booking.areaId,
        side: how.side,
        reasonCode: how.reason,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** One unit's visitor bookings, decided by one writer at a time. */
  private async lockUnitParking(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`parking-unit:${this.ctx.txTenantId}:${unitId}`}))`;
  }

  private async lockArea(
    tx: TenantTxClient,
    id: string,
  ): Promise<VisitorParkingArea | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM visitor_parking_areas WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.visitorParkingArea.findUniqueOrThrow({ where: { id } });
  }

  async lockRow(
    tx: TenantTxClient,
    id: string,
  ): Promise<VisitorParkingBooking> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM visitor_parking_bookings WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw bookingNotFound();
    return tx.visitorParkingBooking.findUniqueOrThrow({ where: { id } });
  }

  /** visitorsInvite on the unit; no place at all is "not found". */
  private async requireInviter(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<void> {
    const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
    if (!caps?.unitView) throw unitNotFound();
    if (!caps.visitorsInvite)
      throw appError.forbidden(
        ErrorCode.VISITOR_PARKING_NOT_ALLOWED,
        'Not allowed to book visitor parking for this unit',
      );
  }

  /** A booking the caller sees: its booker's, or any of the unit's for its primary. */
  private async visible(
    tx: TenantTxClient,
    id: string,
  ): Promise<VisitorParkingBooking> {
    const booking = await tx.visitorParkingBooking.findUnique({
      where: { id },
    });
    if (!booking) throw bookingNotFound();
    const me = this.ctx.accountId;
    const caps = await this.community.placeIn(tx, me, booking.unitId);
    if (!caps?.visitorsInvite) throw bookingNotFound();
    if (
      booking.bookedById !== me &&
      !(await this.community.isPrimary(tx, booking.unitId, me))
    )
      throw bookingNotFound();
    return booking;
  }

  private checkWindow(
    startsAt: Date,
    endsAt: Date,
    now: Date,
    maxHours: number,
  ): void {
    const fields: FieldError[] = [];
    if (startsAt.getTime() < now.getTime() - EARLIEST_MINUTES * MINUTE)
      fields.push({
        field: 'startsAt',
        code: FieldErrorCode.PARKING_TOO_EARLY,
        params: { minutes: EARLIEST_MINUTES },
      });
    if (startsAt.getTime() > now.getTime() + DAYS_AHEAD * DAY)
      fields.push({
        field: 'startsAt',
        code: FieldErrorCode.PARKING_TOO_FAR,
        params: { days: DAYS_AHEAD },
      });
    const minutes = (endsAt.getTime() - startsAt.getTime()) / MINUTE;
    if (minutes < MIN_MINUTES)
      fields.push({
        field: 'endsAt',
        code: FieldErrorCode.PARKING_TOO_SHORT,
        params: { minutes: MIN_MINUTES },
      });
    if (minutes > maxHours * 60)
      fields.push({
        field: 'endsAt',
        code: FieldErrorCode.PARKING_TOO_LONG,
        params: { hours: maxHours },
      });
    if (fields.length) throw invalid(fields);
  }

  /**
   * Under the pass's row (FOR SHARE): one of the unit's, the caller
   * manages it, active, and the window inside its validity. One answer for
   * a pass that is unknown, another unit's or not the caller's to manage.
   */
  private async checkPass(
    tx: TenantTxClient,
    unitId: string,
    passId: string,
    startsAt: Date,
    endsAt: Date,
    now: Date,
  ): Promise<void> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM visitor_passes WHERE id = ${passId}::uuid FOR SHARE`;
    const pass: VisitorPass | null = locked.length
      ? await tx.visitorPass.findUnique({ where: { id: passId } })
      : null;
    const me = this.ctx.accountId;
    const manages =
      pass !== null &&
      pass.unitId === unitId &&
      (pass.hostAccountId === me ||
        (await this.community.isPrimary(tx, unitId, me)));
    if (!pass || !manages || pass.status !== 'active' || pass.validUntil <= now)
      throw invalid([
        { field: 'visitorPassId', code: FieldErrorCode.PASS_NOT_AVAILABLE },
      ]);
    if (startsAt < pass.validFrom || endsAt > pass.validUntil)
      throw invalid([
        {
          field: 'startsAt',
          code: FieldErrorCode.PARKING_OUTSIDE_PASS,
          params: {
            validFrom: pass.validFrom.toISOString(),
            validUntil: pass.validUntil.toISOString(),
          },
        },
      ]);
  }
}

/** A booking cancelled already, or ended, takes no cancellation (409). */
export function checkCancellable(
  booking: VisitorParkingBooking,
  now: Date,
): void {
  if (booking.status !== 'confirmed')
    throw appError.conflict(
      ErrorCode.VISITOR_PARKING_INVALID_TRANSITION,
      'The booking was cancelled already',
      { params: { status: booking.status } },
    );
  if (booking.endsAt <= now)
    throw appError.conflict(
      ErrorCode.VISITOR_PARKING_WINDOW_PASSED,
      'The booking has ended',
    );
}
