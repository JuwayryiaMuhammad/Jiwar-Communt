import { createHash } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type Booking, type FacilityClosure } from '@prisma/client';
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
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { FacilitiesAccess } from '../access';
import { HOLDING } from '../bookings/booking-rules';
import { BookingsService } from '../bookings/bookings.service';
import { dbNow } from '../db-clock';
import { BookingNotices } from '../notices/booking-notices';
import { WaitlistOffers } from '../waitlist/waitlist-offers';
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
  /** The preview's token (ADR 0084): what the closure may cancel and credit. */
  previewToken?: string;
}

/** What a closure would do to one booking (ADR 0084). */
export interface PreviewedBooking {
  id: string;
  unitCode: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  /** Its fee, if one was raised and not credited yet. */
  charge: {
    amount: string;
    status: 'open' | 'paid';
    /** open: the invoice is credited, nothing owed; paid: the money goes to the unit's credit. */
    outcome: 'invoice_credited' | 'unit_credit';
  } | null;
}

export interface ClosurePreview {
  bookings: PreviewedBooking[];
  /** Fees of unpaid invoices credited off: nothing more owed. */
  invoicesCredited: string;
  /** Fees already paid, given back as the units' credit. */
  unitCredit: string;
  /** Sent back with the closure: it then applies exactly this, or refuses. */
  previewToken: string;
}

const PAGE = keysetCursor('startsAt');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

/** A closure's window: after its start, at most a year and a day. */
function checkWindow(input: { startsAt: Date; endsAt: Date }): void {
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
}

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
    private readonly waitlist: WaitlistOffers,
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
   * What closing the facility from `startsAt` to `endsAt` would do now (ADR
   * 0084): the bookings it would cancel and what their fees would become —
   * an unpaid one's invoice credited, a paid one's money the unit's credit
   * (ADR 0070's credit path, the only one) — and a token for the closure.
   * Read as things stand; the closure decides again under its locks.
   */
  preview(
    facilityId: string,
    input: { startsAt: Date; endsAt: Date },
  ): Promise<ClosurePreview> {
    checkWindow(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.facilities.inTx(tx, facilityId);
      const now = await dbNow(tx);
      const rows = await tx.booking.findMany({
        where: {
          facilityId,
          status: { in: [...HOLDING] },
          startsAt: { lt: input.endsAt, gt: now },
          endsAt: { gt: input.startsAt },
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      });
      return this.previewOf(tx, facilityId, input, rows);
    });
  }

  /**
   * Closes the facility from `startsAt` to `endsAt` (at most a year and a
   * day; not already over) and cancels the bookings it overlaps that have
   * not started. When any of them has a fee not credited yet, only with
   * its preview's token (FACILITY_CLOSURE_PREVIEW_REQUIRED); with a token,
   * only if the bookings and fees it would cancel and credit are exactly
   * the previewed ones (FACILITY_CLOSURE_PREVIEW_STALE): read after the
   * facility's row and the charged units' finance locks, so nothing can
   * change them before they are cancelled.
   */
  create(
    facilityId: string,
    input: NewClosure,
  ): Promise<{ closure: FacilityClosure; cancelled: number }> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.facilityClosure,
    );
    checkWindow(input);
    return this.createChecked(facilityId, input, reason);
  }

  private createChecked(
    facilityId: string,
    input: NewClosure,
    reason: string,
  ): Promise<{ closure: FacilityClosure; cancelled: number }> {
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
      // The charges' rule (ADR 0070): the units of the bookings it cancels
      // that have a fee take their finance lock before the bookings' rows;
      // the facility's row, held FOR UPDATE, keeps new ones out meanwhile.
      await this.bookings.lockChargedUnits(
        tx,
        await tx.booking.findMany({
          where: {
            facilityId,
            status: { in: [...HOLDING] },
            startsAt: { lt: input.endsAt, gt: now },
            endsAt: { gt: input.startsAt },
          },
          select: { id: true, unitId: true },
        }),
      );
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM bookings
         WHERE facility_id = ${facilityId}::uuid
           AND status::text = ANY(${[...HOLDING]}::text[])
           AND starts_at < ${input.endsAt} AND ends_at > ${input.startsAt}
           AND starts_at > ${now}
         ORDER BY id FOR UPDATE`;
      // What it cancels and credits, as it stands under the locks (ADR
      // 0084): exactly what was previewed, or nothing.
      const held = await this.previewOf(
        tx,
        facilityId,
        input,
        await tx.booking.findMany({
          where: { id: { in: ids.map((r) => r.id) } },
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        }),
      );
      if (input.previewToken === undefined) {
        if (held.bookings.some((b) => b.charge))
          throw appError.conflict(
            ErrorCode.FACILITY_CLOSURE_PREVIEW_REQUIRED,
            'Preview the closure first: it cancels bookings with a fee',
          );
      } else if (input.previewToken !== held.previewToken)
        throw appError.conflict(
          ErrorCode.FACILITY_CLOSURE_PREVIEW_STALE,
          'The bookings changed since the preview',
        );
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
          // Its slots are closed: their waitlists close below.
          offer: false,
        });
        await this.notices.send(
          tx,
          [booking.bookedById],
          'booking.cancelled_by_closure',
          booking.id,
          { reason },
        );
      }
      await this.waitlist.closeIn(
        tx,
        facility,
        input.startsAt,
        input.endsAt,
        now,
      );
      await this.audit.record(tx, {
        action: 'facility_closure.created',
        targetId: closure.id,
        metadata: {
          facilityId,
          reasonCode: reason,
          startsAt: input.startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
          cancelledCount: ids.length,
          previewed: input.previewToken !== undefined,
          invoicesCredited: held.invoicesCredited,
          unitCredit: held.unitCredit,
        },
      });
      return { closure, cancelled: ids.length };
    });
  }

  private async previewOf(
    tx: TenantTxClient,
    facilityId: string,
    window: { startsAt: Date; endsAt: Date },
    rows: readonly Booking[],
  ): Promise<ClosurePreview> {
    const charges = await this.bookings.chargesOf(tx, rows);
    const codes = new Map(
      (
        await tx.unit.findMany({
          where: { id: { in: [...new Set(rows.map((b) => b.unitId))] } },
          select: { id: true, code: true },
        })
      ).map((u) => [u.id, u.code]),
    );
    let invoices = new Prisma.Decimal(0);
    let credit = new Prisma.Decimal(0);
    const bookings = rows.map((b): PreviewedBooking => {
      const c = charges.get(b.id);
      const live = c && c.status !== 'cancelled' ? c : null;
      if (live?.status === 'open') invoices = invoices.add(live.amount);
      if (live?.status === 'paid') credit = credit.add(live.amount);
      return {
        id: b.id,
        unitCode: codes.get(b.unitId)!,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        status: b.status,
        charge: live
          ? {
              amount: live.amount,
              status: live.status as 'open' | 'paid',
              outcome:
                live.status === 'paid' ? 'unit_credit' : 'invoice_credited',
            }
          : null,
      };
    });
    // A digest of what it would do, not a secret: equal exactly when the
    // same bookings, in the same states, with the same fees are at stake.
    const previewToken = createHash('sha256')
      .update(
        JSON.stringify([
          facilityId,
          window.startsAt.toISOString(),
          window.endsAt.toISOString(),
          [...bookings]
            .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
            .map((b) => [
              b.id,
              b.status,
              b.charge?.status ?? null,
              b.charge?.amount ?? null,
            ]),
        ]),
      )
      .digest('hex');
    return {
      bookings,
      invoicesCredited: invoices.toFixed(2),
      unitCredit: credit.toFixed(2),
      previewToken,
    };
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
