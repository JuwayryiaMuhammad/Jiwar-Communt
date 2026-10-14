import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FacilityClosure } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { FacilitiesAccess } from '../access';
import { HOLDING } from '../bookings/booking-rules';
import { BookingsService } from '../bookings/bookings.service';
import { dbNow } from '../db-clock';
import { BookingNotices } from '../notices/booking-notices';
import { FacilitiesService } from '../setup/facilities.service';
import { FacilityClosureView } from './views/closure.views';

export const CLOSURE_RESOURCE = 'facility_closure';
/** A closure lasts at most a year and a day (CHECK facility_closures_window). */
export const MAX_CLOSURE_DAYS = 366;
const DAY = 86_400_000;

export interface NewClosure {
  startsAt: Date;
  endsAt: Date;
  reasonCode?: string;
}

const PAGE = keysetCursor('startsAt');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const closureNotFound = () =>
  appError.notFound(ErrorCode.FACILITY_CLOSURE_NOT_FOUND, 'Closure not found');

/**
 * A facility closed for a time (ADR 0044), with a reason code, managed with
 * `facilities.manage`. Creating one cancels every booking of the facility
 * that holds a place in it and has not started yet — by the system, with
 * the reason `facility_closed`, pointing at the closure — and tells each
 * booker. A booking under way is left as it is.
 *
 * Locks: the actor's account, then the facility's row FOR UPDATE — a
 * booking holds it FOR SHARE while it decides, so it either committed
 * before (and is cancelled here) or waits and then sees the closure —
 * then the bookings it cancels, in id order. No unit lock: cancelling only
 * frees places and quota.
 */
@Injectable()
export class ClosuresService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly access: FacilitiesAccess,
    private readonly facilities: FacilitiesService,
    private readonly bookings: BookingsService,
    private readonly notices: BookingNotices,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(CLOSURE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => ({
        ...FacilityClosureView.from(
          await tx.facilityClosure.findUniqueOrThrow({ where: { id } }),
        ),
        cancelledBookings: await tx.booking.count({ where: { closureId: id } }),
      })),
    );
  }

  /** The facility's closures, latest start first, lifted ones included. */
  list(
    facilityId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<FacilityClosure>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.facilities.inTx(tx, facilityId);
      const limit = clampLimit(q.limit);
      const rows = await tx.facilityClosure.findMany({
        where: { AND: [{ facilityId }, ...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  /**
   * Closes the facility from `startsAt` to `endsAt` (at most a year and a
   * day; not already over) and cancels the bookings it overlaps that have
   * not started.
   */
  create(
    facilityId: string,
    input: NewClosure,
  ): Promise<{ closure: FacilityClosure; cancelled: number }> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.facilityClosure,
    );
    const fields: FieldError[] = [];
    if (input.endsAt.getTime() <= input.startsAt.getTime())
      fields.push({ field: 'endsAt', code: FieldErrorCode.ENDS_BEFORE_START });
    else if (
      input.endsAt.getTime() - input.startsAt.getTime() >
      MAX_CLOSURE_DAYS * DAY
    )
      fields.push({
        field: 'endsAt',
        code: FieldErrorCode.CLOSURE_TOO_LONG,
        params: { days: MAX_CLOSURE_DAYS },
      });
    if (fields.length) throw invalid(fields);

    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CLOSURE_RESOURCE, id });
      await this.access.lockSelf(tx);
      const facility = await this.facilities.lock(tx, facilityId, 'update');
      const now = await dbNow(tx);
      if (input.endsAt.getTime() <= now.getTime())
        throw invalid([
          { field: 'endsAt', code: FieldErrorCode.CLOSURE_ENDED },
        ]);
      const closure = await tx.facilityClosure.create({
        data: {
          id,
          tenantId: facility.tenantId,
          facilityId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          reasonCode: reason,
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM bookings
         WHERE facility_id = ${facilityId}::uuid
           AND status::text = ANY(${[...HOLDING]}::text[])
           AND starts_at < ${input.endsAt} AND ends_at > ${input.startsAt}
           AND starts_at > ${now}
         ORDER BY id FOR UPDATE`;
      for (const { id: bookingId } of ids) {
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
        });
        await this.bookings.end(tx, booking, {
          side: 'system',
          reason: 'facility_closed',
          by: null,
          now,
          closureId: closure.id,
        });
        await this.notices.send(
          tx,
          [booking.bookedById],
          'booking.cancelled_by_closure',
          booking.id,
          { reason },
        );
      }
      await this.audit.record(tx, {
        action: 'facility_closure.created',
        targetId: closure.id,
        metadata: {
          facilityId,
          reasonCode: reason,
          startsAt: input.startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
          cancelledCount: ids.length,
        },
      });
      return { closure, cancelled: ids.length };
    });
  }

  /**
   * Lifts a closure, once, with a reason code: its window is open to
   * bookings again. What it cancelled stays cancelled.
   */
  lift(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.facilityClosureLift,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.facilityClosure.findUnique({ where: { id } });
      if (!seen) throw closureNotFound();
      await this.facilities.lock(tx, seen.facilityId, 'update');
      const closure = await tx.facilityClosure.findUniqueOrThrow({
        where: { id },
      });
      if (closure.liftedAt)
        throw appError.conflict(
          ErrorCode.FACILITY_CLOSURE_LIFTED,
          'This closure was lifted already',
        );
      const now = await dbNow(tx);
      await tx.facilityClosure.update({
        where: { id },
        data: {
          liftedAt: now,
          liftedById: this.ctx.accountId,
          liftReasonCode: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'facility_closure.lifted',
        targetId: id,
        metadata: { facilityId: closure.facilityId, reasonCode: reason },
      });
    });
  }
}
