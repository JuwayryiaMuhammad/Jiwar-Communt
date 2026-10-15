import { Injectable } from '@nestjs/common';
import type {
  Account,
  Prisma,
  UnitParkingSlot,
  VisitorParkingArea,
  VisitorParkingBooking,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
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
  zonedInstant,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { VehicleCore } from '../vehicles/vehicle-core';
import { AREA_NAME, SLOT_CODE, SLOT_PLACE } from './parking-rules';
import {
  checkCancellable,
  VisitorParkingService,
} from './visitor-parking.service';

type Person = Pick<Account, 'id' | 'fullName' | 'status'>;

export interface StaffSlot {
  slot: UnitParkingSlot;
  unitCode: string;
}

/** A booking as the staff see it: the unit, the visitor and who booked. */
export interface StaffParking {
  booking: VisitorParkingBooking;
  unitCode: string;
  areaName: string;
  bookedBy: Person;
}

const SLOTS = keysetCursor('createdAt', 'desc');
/** One day's bookings of the compound at most: a bounded list. */
const DAY_LIMIT = 1000;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });
const slotNotFound = () =>
  appError.notFound(ErrorCode.PARKING_SLOT_NOT_FOUND, 'Parking slot not found');
const areaNotFound = () =>
  appError.notFound(
    ErrorCode.VISITOR_PARKING_AREA_NOT_FOUND,
    'Visitor parking area not found',
  );

/** Trimmed, single-spaced, in range; else its field error. */
function text(
  field: string,
  raw: string,
  range: { min: number; max: number },
  fields: FieldError[],
): string {
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length < range.min || value.length > range.max)
    fields.push({
      field,
      code: FieldErrorCode.INVALID_LENGTH,
      params: { ...range },
    });
  return value;
}

/**
 * Parking for the staff (ADR 0045), `vehicles.manage`: the units' own
 * slots (a code, once in the compound, and a place), the visitor areas
 * (a name and a capacity; retired, never deleted), a day's visitor
 * bookings and their cancellation with a reason code.
 */
@Injectable()
export class StaffParkingService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly community: CommunityGatePort,
    private readonly tenantSettings: TenantSettingsService,
    private readonly core: VehicleCore,
    private readonly parking: VisitorParkingService,
  ) {}

  // --------------------------------------------------------------------------
  // Slots
  // --------------------------------------------------------------------------

  listSlots(q: {
    unitCode?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<StaffSlot>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const where: Prisma.UnitParkingSlotWhereInput[] = [
        ...(SLOTS.after(q.cursor) as Prisma.UnitParkingSlotWhereInput[]),
      ];
      if (q.unitCode) {
        const unit = await this.community.unitByCode(tx, q.unitCode);
        if (!unit) return { items: [], nextCursor: null };
        where.push({ unitId: unit.id });
      }
      const rows = await tx.unitParkingSlot.findMany({
        where: { AND: where },
        orderBy: SLOTS.orderBy,
        take: limit + 1,
      });
      const page = SLOTS.toPage(rows, limit);
      const codes = await this.core.unitCodes(
        tx,
        page.items.map((s) => s.unitId),
      );
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((slot) => ({
          slot,
          unitCode: codes.get(slot.unitId) ?? '',
        })),
      };
    });
  }

  /** A slot for the unit of that code; its code is the compound's once. */
  createSlot(input: {
    unitCode: string;
    code: string;
    place: string;
  }): Promise<StaffSlot> {
    const fields: FieldError[] = [];
    const code = text('code', input.code, SLOT_CODE, fields).toUpperCase();
    const place = text('place', input.place, SLOT_PLACE, fields);
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const unit = await this.community.unitByCode(tx, input.unitCode);
      if (!unit)
        throw invalid([
          { field: 'unitCode', code: FieldErrorCode.UNIT_CODE_UNKNOWN },
        ]);
      const id = newId();
      const slot = await tx.unitParkingSlot.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          unitId: unit.id,
          code,
          place,
        },
      });
      await this.audit.record(tx, {
        action: 'parking_slot.created',
        targetId: id,
        metadata: { unitId: unit.id, code, place },
      });
      return { slot, unitCode: unit.code };
    });
  }

  updateSlot(
    id: string,
    input: { code?: string; place?: string },
  ): Promise<StaffSlot> {
    const fields: FieldError[] = [];
    const code =
      input.code !== undefined
        ? text('code', input.code, SLOT_CODE, fields).toUpperCase()
        : undefined;
    const place =
      input.place !== undefined
        ? text('place', input.place, SLOT_PLACE, fields)
        : undefined;
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.unitParkingSlot.findUnique({ where: { id } });
      if (!before) throw slotNotFound();
      const slot = await tx.unitParkingSlot.update({
        where: { id },
        data: { code, place },
      });
      const changes = diffChanges(
        { code: before.code, place: before.place },
        { code: slot.code, place: slot.place },
        'parking_slot.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'parking_slot.updated',
          targetId: id,
          changes,
          metadata: { unitId: slot.unitId },
        });
      return {
        slot,
        unitCode: await this.community.unitCode(tx, slot.unitId),
      };
    });
  }

  deleteSlot(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const slot = await tx.unitParkingSlot.findUnique({ where: { id } });
      if (!slot) throw slotNotFound();
      await tx.unitParkingSlot.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'parking_slot.deleted',
        targetId: id,
        metadata: { unitId: slot.unitId, code: slot.code },
      });
    });
  }

  // --------------------------------------------------------------------------
  // Visitor areas
  // --------------------------------------------------------------------------

  /** Every area, retired ones included (a compound has a handful). */
  areas(): Promise<VisitorParkingArea[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.visitorParkingArea.findMany({
        orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  createArea(input: {
    name: string;
    capacity: number;
  }): Promise<VisitorParkingArea> {
    const fields: FieldError[] = [];
    const name = text('name', input.name, AREA_NAME, fields);
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      const area = await tx.visitorParkingArea.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          name,
          capacity: input.capacity,
        },
      });
      await this.audit.record(tx, {
        action: 'visitor_parking_area.created',
        targetId: id,
        changes: diffChanges(
          null,
          { name, capacity: input.capacity, active: true },
          'visitor_parking_area.created',
        ),
      });
      return area;
    });
  }

  /**
   * Renames, resizes or retires an area under its row lock, so no booking
   * of it is being decided meanwhile. A smaller capacity or a retirement
   * leaves what is booked: the day view shows it over capacity.
   */
  updateArea(
    id: string,
    input: { name?: string; capacity?: number; active?: boolean },
  ): Promise<VisitorParkingArea> {
    const fields: FieldError[] = [];
    const name =
      input.name !== undefined
        ? text('name', input.name, AREA_NAME, fields)
        : undefined;
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM visitor_parking_areas WHERE id = ${id}::uuid FOR UPDATE`;
      if (!rows.length) throw areaNotFound();
      const before = await tx.visitorParkingArea.findUniqueOrThrow({
        where: { id },
      });
      const area = await tx.visitorParkingArea.update({
        where: { id },
        data: { name, capacity: input.capacity, active: input.active },
      });
      const view = (a: VisitorParkingArea) => ({
        name: a.name,
        capacity: a.capacity,
        active: a.active,
      });
      const changes = diffChanges(
        view(before),
        view(area),
        'visitor_parking_area.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'visitor_parking_area.updated',
          targetId: id,
          changes,
        });
      return area;
    });
  }

  // --------------------------------------------------------------------------
  // Visitor bookings
  // --------------------------------------------------------------------------

  /**
   * One local day's bookings (today by default), of one area or every one:
   * those whose window touches the day, cancelled ones included, soonest
   * first.
   */
  bookings(q: { areaId?: string; day?: LocalDate }): Promise<StaffParking[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { timezone } = await this.tenantSettings.inTx(
        tx,
        this.ctx.txTenantId,
      );
      const day = q.day ?? localDate(await dbNow(tx), timezone);
      const from = zonedInstant(day, 0, timezone)!;
      const to = zonedInstant(addDays(day, 1), 0, timezone)!;
      const rows = await tx.visitorParkingBooking.findMany({
        where: {
          ...(q.areaId ? { areaId: q.areaId } : {}),
          startsAt: { lt: to },
          endsAt: { gt: from },
        },
        include: { area: { select: { name: true } } },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: DAY_LIMIT,
      });
      const codes = await this.core.unitCodes(
        tx,
        rows.map((b) => b.unitId),
      );
      const people = await this.people(
        tx,
        rows.map((b) => b.bookedById),
      );
      return rows.map((b) => ({
        booking: b,
        unitCode: codes.get(b.unitId) ?? '',
        areaName: b.area.name,
        bookedBy: people.get(b.bookedById)!,
      }));
    });
  }

  /** The staff cancel a booking before it ends, with a reason code. */
  cancel(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.visitorParkingStaffCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const booking = await this.parking.lockRow(tx, id);
      const now = await dbNow(tx);
      checkCancellable(booking, now);
      await this.parking.end(tx, booking, {
        side: 'staff',
        reason,
        by: this.ctx.accountId,
        now,
      });
    });
  }

  private async people(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<Map<string, Person>> {
    if (!ids.length) return new Map();
    const rows = await tx.account.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, fullName: true, status: true },
    });
    return new Map(rows.map((a) => [a.id, a]));
  }
}
