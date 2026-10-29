import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  ManagementActorSide,
  ManagementAppointment,
  ManagementAppointmentMode,
  ManagementAppointmentStatus,
  ManagementRequest,
  ManagementSide,
  Prisma,
} from '@prisma/client';
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
import {
  addDays,
  localDate,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { RequestLifecycle } from '../requests/lifecycle.service';
import { RequestAccess, type Audience } from '../requests/request-access';
import { RequestNotices } from '../requests/request-notices';
import { RequestProgress } from '../requests/request-progress';
import { assertCan } from '../requests/request-rules';
import { OfficeHoursService } from '../settings/office-hours.service';
import { RequestSettingsService } from '../settings/request-settings.service';
import {
  DEFAULT_SLOT_DAYS,
  MAX_AHEAD_MS,
  MIN_LEAD_MS,
  openSlots,
  slotAt,
  type OfficeCalendar,
  type OpenSlot,
} from './appointment-slots';

export const APPOINTMENT_RESOURCE = 'management_appointment';

/** Holding a place in its slot. */
export const LIVE: readonly ManagementAppointmentStatus[] = [
  'requested',
  'proposed',
  'confirmed',
];

export interface SlotChoice {
  /** The start of one of the offered slots, exactly. */
  startsAt: Date;
  mode: ManagementAppointmentMode;
}

export interface AppointmentsQuery {
  status?: ManagementAppointmentStatus;
  /** Holding a slot: requested, proposed or confirmed. */
  live?: boolean;
  /** Starting at or after. */
  from?: Date;
  /** Starting before. */
  to?: Date;
  cursor?: string;
  limit?: number;
}

/** Soonest first: an agenda. */
const PAGE = keysetCursor('startsAt', 'asc');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid appointment', {
    fields,
  });

/**
 * Appointments with the management (ADR 0039), on requests of type
 * `appointment`. The resident picks a free slot of the office hours; staff
 * confirm it or propose another, which the resident accepts or answers by
 * picking again; either side cancels with a reason code.
 *
 * `requested` waits for staff, `proposed` waits for the resident,
 * `confirmed` is agreed. All three hold a place in their slot. A request
 * has one live appointment: a new pick or proposal ends the old one as
 * `superseded` in the same transaction.
 *
 * Capacity: a booking takes the row lock of its slot
 * (management_appointment_slots), then counts the live appointments on
 * that window and refuses at the compound's capacity. Bookings of one slot
 * therefore run one after the other, whatever requests they are on, and a
 * slot never holds more than its capacity. The settings row is share-locked
 * for the booking, so the slot length and the capacity it read stay true
 * until it commits. Locks: account, request, settings, slot — always in
 * that order.
 */
@Injectable()
export class AppointmentsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: RequestAccess,
    private readonly progress: RequestProgress,
    private readonly lifecycle: RequestLifecycle,
    private readonly settings: RequestSettingsService,
    private readonly hours: OfficeHoursService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notices: RequestNotices,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(APPOINTMENT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const a = await tx.managementAppointment.findUniqueOrThrow({
          where: { id },
        });
        return {
          id: a.id,
          status: a.status,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
        };
      }),
    );
    // A request that closes — by staff, its author or the sweep — frees
    // its slot in the same transaction.
    this.lifecycle.onClosing(async (tx, request, now) => {
      const live = await this.live(tx, request.id);
      if (live)
        await this.end(tx, request, live, 'request_closed', 'system', now);
    });
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  /**
   * The slots still open on `days` local days from `from` (today in the
   * compound's time zone). A read, not a reservation: booking checks again
   * under the slot's lock.
   */
  slots(q: { from?: LocalDate; days?: number }): Promise<OpenSlot[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const settings = await this.settings.inTx(tx);
      const calendar = await this.calendar(tx, settings.appointmentSlotMinutes);
      const now = await dbNow(tx);
      const from = q.from ?? localDate(now, calendar.timeZone);
      const days = q.days ?? DEFAULT_SLOT_DAYS;
      // A day either side covers every time zone's offset.
      const lo = new Date(`${addDays(from, -1)}T00:00:00.000Z`);
      const hi = new Date(`${addDays(from, days + 1)}T00:00:00.000Z`);
      const booked = await tx.managementAppointment.findMany({
        where: {
          status: { in: [...LIVE] },
          startsAt: { lt: hi },
          endsAt: { gt: lo },
        },
        select: { startsAt: true, endsAt: true },
      });
      return openSlots({
        from,
        days,
        calendar,
        capacity: settings.appointmentSlotCapacity,
        now,
        booked,
      });
    });
  }

  /** The request's live appointment, else its most recent one. */
  async current(
    tx: TenantTxClient,
    requestId: string,
  ): Promise<ManagementAppointment | null> {
    return (
      (await this.live(tx, requestId)) ??
      (await tx.managementAppointment.findFirst({
        where: { requestId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }))
    );
  }

  /** The compound's appointments, soonest first (staff). */
  listForStaff(q: AppointmentsQuery): Promise<Page<ManagementAppointment>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const where: Prisma.ManagementAppointmentWhereInput = {
        AND: [
          q.status ? { status: q.status } : {},
          q.live ? { status: { in: [...LIVE] } } : {},
          q.from ? { startsAt: { gte: q.from } } : {},
          q.to ? { startsAt: { lt: q.to } } : {},
          ...PAGE.after(q.cursor),
        ],
      };
      const limit = clampLimit(q.limit);
      const rows = await tx.managementAppointment.findMany({
        where,
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  private live(
    tx: TenantTxClient,
    requestId: string,
  ): Promise<ManagementAppointment | null> {
    return tx.managementAppointment.findFirst({
      where: { requestId, status: { in: [...LIVE] } },
    });
  }

  private async calendar(
    tx: TenantTxClient,
    slotMinutes: number,
  ): Promise<OfficeCalendar> {
    const { timezone } = await this.tenantSettings.inTx(
      tx,
      this.ctx.txTenantId,
    );
    return {
      windows: await this.hours.inTx(tx),
      slotMinutes,
      timeZone: timezone,
    };
  }

  // --------------------------------------------------------------------------
  // The author
  // --------------------------------------------------------------------------

  /**
   * The author picks a slot: at first on a new request (`bookAtCreation`),
   * later to move the appointment or to answer a proposal with another
   * time. The pick waits for staff (`requested`).
   */
  book(requestId: string, choice: SlotChoice): Promise<ManagementAppointment> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: APPOINTMENT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const request = await this.locked(tx, requestId, 'resident');
      const now = await dbNow(tx);
      const { appointment } = await this.reserve(tx, request, choice, {
        id,
        side: 'resident',
        status: 'requested',
        now,
      });
      await tx.managementRequest.update({
        where: { id: request.id },
        data: { lastActivityAt: now },
      });
      await this.notices.toHandlers(
        tx,
        request,
        'management_appointment.requested',
      );
      return appointment;
    });
  }

  /** The author accepts staff's proposal: confirmed. */
  accept(requestId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const request = await this.locked(tx, requestId, 'resident');
      const now = await dbNow(tx);
      await this.confirmRow(tx, request, 'proposed', 'resident', now);
      await tx.managementRequest.update({
        where: { id: request.id },
        data: { lastActivityAt: now },
      });
      await this.notices.toHandlers(
        tx,
        request,
        'management_appointment.accepted',
      );
    });
  }

  cancelByAuthor(requestId: string, reasonCode?: string): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.managementAppointmentCancelByResident,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const request = await this.locked(tx, requestId, 'resident');
      const now = await dbNow(tx);
      await this.end(
        tx,
        request,
        await this.mustBeLive(tx, request),
        reason,
        'resident',
        now,
      );
      await tx.managementRequest.update({
        where: { id: request.id },
        data: { lastActivityAt: now },
      });
      await this.notices.toHandlers(
        tx,
        request,
        'management_appointment.cancelled_by_resident',
      );
    });
  }

  // --------------------------------------------------------------------------
  // Staff
  // --------------------------------------------------------------------------

  /** Staff confirm the author's pick. A response: the clock stops. */
  confirm(requestId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const request = await this.locked(tx, requestId, 'staff');
      const now = await dbNow(tx);
      await this.confirmRow(tx, request, 'requested', 'staff', now);
      await this.progress.responded(tx, request, 'appointment', now);
      await this.notices.toAuthor(
        tx,
        request,
        'management_appointment.confirmed',
      );
    });
  }

  /**
   * Staff propose a slot: instead of the author's pick (a counter-proposal),
   * or when the request has no live appointment. It waits for the author
   * (`proposed`). A response: the clock stops.
   */
  propose(
    requestId: string,
    choice: SlotChoice,
  ): Promise<ManagementAppointment> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: APPOINTMENT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const request = await this.locked(tx, requestId, 'staff');
      const now = await dbNow(tx);
      const { appointment, replaced } = await this.reserve(
        tx,
        request,
        choice,
        { id, side: 'staff', status: 'proposed', now },
      );
      await this.progress.responded(tx, request, 'appointment', now);
      await this.notices.toAuthor(
        tx,
        request,
        replaced
          ? 'management_appointment.countered'
          : 'management_appointment.proposed',
      );
      return appointment;
    });
  }

  cancelByStaff(requestId: string, reasonCode?: string): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.managementAppointmentCancelByStaff,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const request = await this.locked(tx, requestId, 'staff');
      const now = await dbNow(tx);
      await this.end(
        tx,
        request,
        await this.mustBeLive(tx, request),
        reason,
        'staff',
        now,
      );
      await tx.managementRequest.update({
        where: { id: request.id },
        data: { lastActivityAt: now },
      });
      await this.notices.toAuthor(
        tx,
        request,
        'management_appointment.cancelled',
      );
    });
  }

  // --------------------------------------------------------------------------
  // The rules, under the request's lock
  // --------------------------------------------------------------------------

  /**
   * The slot of a request being opened, in the creating transaction: the
   * author's pick waits for staff; a slot staff book for a resident who
   * called or came in is agreed already (`confirmed`).
   */
  async bookAtCreation(
    tx: TenantTxClient,
    request: ManagementRequest,
    choice: SlotChoice,
    side: ManagementSide,
    now: Date,
  ): Promise<ManagementAppointment> {
    const { appointment } = await this.reserve(tx, request, choice, {
      id: newId(),
      side,
      status: side === 'staff' ? 'confirmed' : 'requested',
      now,
    });
    return appointment;
  }

  /** The request, locked, of type appointment and still live. */
  private async locked(
    tx: TenantTxClient,
    requestId: string,
    audience: Audience,
  ): Promise<ManagementRequest> {
    const request = await this.access.load(tx, requestId, audience, {
      lock: true,
    });
    if (request.type !== 'appointment')
      throw appError.conflict(
        ErrorCode.MANAGEMENT_REQUEST_NOT_AN_APPOINTMENT,
        'This request is not an appointment',
      );
    assertCan(request, 'appointment');
    return request;
  }

  private async mustBeLive(
    tx: TenantTxClient,
    request: ManagementRequest,
  ): Promise<ManagementAppointment> {
    const live = await this.live(tx, request.id);
    if (!live) throw this.wrongState('none');
    return live;
  }

  private wrongState(status: ManagementAppointmentStatus | 'none') {
    return appError.conflict(
      ErrorCode.MANAGEMENT_APPOINTMENT_INVALID_STATE,
      'The appointment does not take this action now',
      { params: { status } },
    );
  }

  /**
   * Takes a place in the slot for the request, under the request's lock:
   * the slot is one the office hours offer now, not too soon and not too
   * far; the request's own live appointment gives its place back first;
   * then the slot's row is locked and its live appointments counted.
   */
  private async reserve(
    tx: TenantTxClient,
    request: ManagementRequest,
    choice: SlotChoice,
    as: {
      id: string;
      side: ManagementSide;
      status: 'requested' | 'proposed' | 'confirmed';
      now: Date;
    },
  ): Promise<{ appointment: ManagementAppointment; replaced: boolean }> {
    const { now } = as;
    const settings = await this.settings.share(tx);
    const calendar = await this.calendar(tx, settings.appointmentSlotMinutes);
    const slot = slotAt(choice.startsAt, calendar);
    if (!slot)
      throw invalid([
        {
          field: 'startsAt',
          code: FieldErrorCode.APPOINTMENT_SLOT_NOT_OFFERED,
        },
      ]);
    const lead = slot.startsAt.getTime() - now.getTime();
    if (lead < MIN_LEAD_MS)
      throw invalid([
        { field: 'startsAt', code: FieldErrorCode.APPOINTMENT_TOO_SOON },
      ]);
    if (lead > MAX_AHEAD_MS)
      throw invalid([
        { field: 'startsAt', code: FieldErrorCode.APPOINTMENT_TOO_FAR },
      ]);

    const previous = await this.live(tx, request.id);
    if (previous)
      await tx.managementAppointment.update({
        where: { id: previous.id },
        data: { status: 'superseded', endedAt: now },
      });

    // The slot's lock: bookings of this slot run one after the other.
    await tx.$executeRaw`
      INSERT INTO management_appointment_slots (tenant_id, starts_at)
      VALUES (${request.tenantId}::uuid, ${slot.startsAt})
      ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`
      SELECT starts_at FROM management_appointment_slots
       WHERE tenant_id = ${request.tenantId}::uuid
         AND starts_at = ${slot.startsAt} FOR UPDATE`;
    const taken = await tx.managementAppointment.count({
      where: {
        status: { in: [...LIVE] },
        startsAt: { lt: slot.endsAt },
        endsAt: { gt: slot.startsAt },
      },
    });
    if (taken >= settings.appointmentSlotCapacity)
      throw appError.conflict(
        ErrorCode.MANAGEMENT_APPOINTMENT_SLOT_FULL,
        'This slot is full',
      );

    const appointment = await tx.managementAppointment.create({
      data: {
        id: as.id,
        tenantId: request.tenantId,
        requestId: request.id,
        status: as.status,
        mode: choice.mode,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        proposedBySide: as.side,
        proposedById: this.ctx.accountId,
        confirmedAt: as.status === 'confirmed' ? now : null,
        createdAt: now,
      },
    });
    await this.audit.record(tx, {
      action:
        as.status === 'requested'
          ? 'management_appointment.requested'
          : as.status === 'proposed'
            ? 'management_appointment.proposed'
            : 'management_appointment.confirmed',
      targetId: appointment.id,
      metadata: {
        requestNumber: request.number,
        mode: choice.mode,
        startsAt: slot.startsAt.toISOString(),
        ...(as.status === 'confirmed'
          ? { by: as.side }
          : { replaces: previous !== null }),
      },
    });
    return { appointment, replaced: previous !== null };
  }

  /**
   * The live appointment, waiting in `from`, becomes confirmed. Not once
   * its start has passed: there is nothing left to agree on.
   */
  private async confirmRow(
    tx: TenantTxClient,
    request: ManagementRequest,
    from: 'requested' | 'proposed',
    by: ManagementSide,
    now: Date,
  ): Promise<void> {
    const live = await this.mustBeLive(tx, request);
    if (live.status !== from) throw this.wrongState(live.status);
    if (live.startsAt.getTime() <= now.getTime())
      throw appError.conflict(
        ErrorCode.MANAGEMENT_APPOINTMENT_WINDOW_PASSED,
        'The appointment’s time has passed',
      );
    await tx.managementAppointment.update({
      where: { id: live.id },
      data: { status: 'confirmed', confirmedAt: now },
    });
    await this.audit.record(tx, {
      action: 'management_appointment.confirmed',
      targetId: live.id,
      metadata: {
        requestNumber: request.number,
        mode: live.mode,
        startsAt: live.startsAt.toISOString(),
        by,
      },
    });
  }

  /** Cancels a live appointment: its place in the slot is free again. */
  private async end(
    tx: TenantTxClient,
    request: ManagementRequest,
    live: ManagementAppointment,
    reason: string,
    by: ManagementActorSide,
    now: Date,
  ): Promise<void> {
    await tx.managementAppointment.update({
      where: { id: live.id },
      data: {
        status: 'cancelled',
        endedAt: now,
        cancelReason: reason,
        cancelledBySide: by,
      },
    });
    await this.audit.record(tx, {
      action: 'management_appointment.cancelled',
      targetId: live.id,
      metadata: {
        requestNumber: request.number,
        reasonCode: reason,
        by,
        fromStatus: live.status,
      },
    });
  }
}
