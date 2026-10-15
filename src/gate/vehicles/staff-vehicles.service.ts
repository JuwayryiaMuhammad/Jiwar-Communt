import { Injectable } from '@nestjs/common';
import type { Account, Prisma, Vehicle, VehicleStatus } from '@prisma/client';
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
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import { normalizePlate, plateKey } from '../../core/common/vehicle-plate';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { CommunityGatePort } from '../../community';
import { VehicleCore, vehicleNotFound } from './vehicle-core';
import {
  asDate,
  dayOf,
  EXPIRING_DAYS,
  MAX_PERMIT_DAYS,
  normalizeSticker,
  permitStatus,
  type PermitStatus,
} from './vehicle-rules';

export interface StaffVehicleFilters {
  status?: PermitStatus;
  unitCode?: string;
  plate?: string;
  cursor?: string;
  limit?: number;
}

type Person = Pick<Account, 'id' | 'fullName' | 'status'>;

/** A vehicle as the staff see it. */
export interface StaffVehicle {
  vehicle: Vehicle;
  unitCode: string;
  permitStatus: PermitStatus;
  registeredBy: Person;
}

export interface StaffVehicleDetail extends StaffVehicle {
  photo: PresignedRead | null;
  decidedBy: Person | null;
  removedBy: Person | null;
}

export interface Approval {
  version: number;
  stickerNumber: string;
  permitValidUntil: LocalDate;
}

/** The pending queue comes oldest first; every other list newest first. */
const QUEUE = keysetCursor('createdAt', 'asc');
const PAGE = keysetCursor('createdAt', 'desc');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

const transition = (status: VehicleStatus) =>
  appError.conflict(
    ErrorCode.VEHICLE_INVALID_TRANSITION,
    'The vehicle is not in a status that allows this',
    { params: { status } },
  );

/**
 * The staff's side of the vehicles (ADR 0045), `vehicles.manage`: every
 * vehicle with its unit and its registrant, the approval with a sticker
 * and a permit's last day, the rejection with a reason code, renewals and
 * removals. Each decision takes the vehicle's row, and an approval or a
 * rejection names the `version` the staff read: a plate changed meanwhile
 * is VEHICLE_CHANGED, never approved unseen.
 */
@Injectable()
export class StaffVehiclesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly community: CommunityGatePort,
    private readonly core: VehicleCore,
  ) {}

  list(f: StaffVehicleFilters): Promise<Page<StaffVehicle>> {
    const limit = clampLimit(f.limit);
    const page = f.status === 'pending' ? QUEUE : PAGE;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today } = await this.core.clock(tx);
      const where: Prisma.VehicleWhereInput[] = [
        statusWhere(f.status, today),
        ...(page.after(f.cursor) as Prisma.VehicleWhereInput[]),
      ];
      if (f.unitCode) {
        const unit = await this.community.unitByCode(tx, f.unitCode);
        if (!unit) return { items: [], nextCursor: null };
        where.push({ unitId: unit.id });
      }
      if (f.plate !== undefined) {
        const plate = normalizePlate(f.plate);
        if (!plate) return { items: [], nextCursor: null };
        where.push({ plateKey: plateKey(plate) });
      }
      const rows = await tx.vehicle.findMany({
        where: { AND: where },
        orderBy: page.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = page.toPage(rows, limit);
      return { items: await this.many(tx, items, today), nextCursor };
    });
  }

  get(id: string): Promise<StaffVehicleDetail> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const vehicle = await tx.vehicle.findUnique({ where: { id } });
      if (!vehicle) throw vehicleNotFound();
      return this.detail(tx, vehicle);
    });
  }

  /**
   * Approves a pending vehicle as the staff read it (`version`): a sticker
   * whose number was never issued in the compound, and the last local day
   * of its permit (after today, at most 731 days ahead). One active permit
   * per plate, decided under the plate's lock.
   */
  approve(id: string, input: Approval): Promise<StaffVehicleDetail> {
    const sticker = normalizeSticker(input.stickerNumber);
    if (!sticker)
      throw invalid([
        { field: 'stickerNumber', code: FieldErrorCode.INVALID_FORMAT },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const seen = await tx.vehicle.findUnique({ where: { id } });
      if (!seen) throw vehicleNotFound();
      await this.core.lockPlate(tx, seen.plateKey ?? '');
      const vehicle = await this.lockRow(tx, id);
      if (vehicle.status !== 'pending') throw transition(vehicle.status);
      if (
        vehicle.version !== input.version ||
        vehicle.plateKey !== seen.plateKey
      )
        throw changed(vehicle);
      const { today } = await this.core.clock(tx);
      checkPermitDate(input.permitValidUntil, today);
      const active = await tx.vehicle.count({
        where: { plateKey: vehicle.plateKey, status: 'active' },
      });
      if (active)
        throw appError.conflict(
          ErrorCode.VEHICLE_PLATE_ACTIVE,
          'Another vehicle holds an active permit for this plate',
        );
      const issued = await tx.vehicleSticker.findFirst({
        where: { stickerNumber: sticker },
        select: { id: true },
      });
      if (issued) throw stickerTaken();
      await tx.vehicleSticker.create({
        data: {
          id: newId(),
          tenantId: vehicle.tenantId,
          vehicleId: id,
          stickerNumber: sticker,
          issuedById: this.ctx.accountId,
        },
      });
      const now = new Date();
      const approved = await tx.vehicle.update({
        where: { id },
        data: {
          status: 'active',
          stickerNumber: sticker,
          permitValidUntil: asDate(input.permitValidUntil),
          decidedById: this.ctx.accountId,
          decidedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'vehicle.approved',
        targetId: id,
        metadata: {
          unitId: vehicle.unitId,
          stickerNumber: sticker,
          permitValidUntil: input.permitValidUntil,
          version: vehicle.version,
        },
      });
      await this.core.notify(
        tx,
        [vehicle.registeredById],
        'vehicle.approved',
        id,
        {},
        this.ctx.accountId,
      );
      return this.detail(tx, approved);
    });
  }

  /** Rejects a pending vehicle as the staff read it, with a reason code. */
  reject(
    id: string,
    input: { version: number; reasonCode?: string },
  ): Promise<StaffVehicleDetail> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.vehicleReject,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const vehicle = await this.lockRow(tx, id);
      if (vehicle.status !== 'pending') throw transition(vehicle.status);
      if (vehicle.version !== input.version) throw changed(vehicle);
      const rejected = await tx.vehicle.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectionReason: reason,
          decidedById: this.ctx.accountId,
          decidedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        action: 'vehicle.rejected',
        targetId: id,
        metadata: {
          unitId: vehicle.unitId,
          reasonCode: reason,
          version: vehicle.version,
        },
      });
      await this.core.notify(
        tx,
        [vehicle.registeredById],
        'vehicle.rejected',
        id,
        { reason },
        this.ctx.accountId,
      );
      return this.detail(tx, rejected);
    });
  }

  /**
   * Renews an active permit: a new last day, after today, not before the
   * current one, at most 731 days ahead. The sticker stays; the expiring
   * notice comes again for the new day.
   */
  renew(id: string, validUntil: LocalDate): Promise<StaffVehicleDetail> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const vehicle = await this.lockRow(tx, id);
      if (vehicle.status !== 'active') throw transition(vehicle.status);
      const { today } = await this.core.clock(tx);
      const current = dayOf(vehicle.permitValidUntil)!;
      checkPermitDate(validUntil, today, current);
      const renewed = await tx.vehicle.update({
        where: { id },
        data: { permitValidUntil: asDate(validUntil) },
      });
      await this.audit.record(tx, {
        action: 'vehicle.renewed',
        targetId: id,
        metadata: { unitId: vehicle.unitId, from: current, to: validUntil },
      });
      return this.detail(tx, renewed);
    });
  }

  /** Removes a vehicle, with a reason code: final, its sticker void. */
  remove(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.vehicleStaffRemove,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const vehicle = await this.lockRow(tx, id);
      if (vehicle.status === 'removed') throw transition(vehicle.status);
      await tx.vehicle.update({
        where: { id },
        data: {
          status: 'removed',
          stickerNumber: null,
          permitValidUntil: null,
          rejectionReason: null,
          removedAt: new Date(),
          removedById: this.ctx.accountId,
          removalSide: 'staff',
          removalReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'vehicle.removed',
        targetId: id,
        metadata: {
          unitId: vehicle.unitId,
          side: 'staff',
          reasonCode: reason,
          previousStatus: vehicle.status,
        },
      });
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async lockRow(tx: TenantTxClient, id: string): Promise<Vehicle> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vehicles WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw vehicleNotFound();
    return tx.vehicle.findUniqueOrThrow({ where: { id } });
  }

  private async many(
    tx: TenantTxClient,
    rows: Vehicle[],
    today: LocalDate,
  ): Promise<StaffVehicle[]> {
    const codes = await this.core.unitCodes(
      tx,
      rows.map((v) => v.unitId),
    );
    const people = await this.people(
      tx,
      rows.map((v) => v.registeredById),
    );
    return rows.map((vehicle) => ({
      vehicle,
      unitCode: codes.get(vehicle.unitId) ?? '',
      permitStatus: permitStatus(
        vehicle.status,
        dayOf(vehicle.permitValidUntil),
        today,
      ),
      registeredBy: people.get(vehicle.registeredById)!,
    }));
  }

  private async detail(
    tx: TenantTxClient,
    vehicle: Vehicle,
  ): Promise<StaffVehicleDetail> {
    const { today } = await this.core.clock(tx);
    const [base] = await this.many(tx, [vehicle], today);
    const people = await this.people(
      tx,
      [vehicle.decidedById, vehicle.removedById].filter(
        (id): id is string => id !== null,
      ),
    );
    return {
      ...base,
      photo: await this.files.readUrl(tx, vehicle.licencePhotoFileId),
      decidedBy: vehicle.decidedById
        ? (people.get(vehicle.decidedById) ?? null)
        : null,
      removedBy: vehicle.removedById
        ? (people.get(vehicle.removedById) ?? null)
        : null,
    };
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

/** The stored status, or the computed permit status, as a filter. */
function statusWhere(
  status: PermitStatus | undefined,
  today: LocalDate,
): Prisma.VehicleWhereInput {
  const soon = asDate(addDays(today, EXPIRING_DAYS));
  switch (status) {
    case undefined:
      return {};
    case 'active':
      return { status: 'active', permitValidUntil: { gt: soon } };
    case 'expires_soon':
      return {
        status: 'active',
        permitValidUntil: { gte: asDate(today), lte: soon },
      };
    case 'expired':
      return { status: 'active', permitValidUntil: { lt: asDate(today) } };
    default:
      return { status };
  }
}

/** A permit's last day: after today (and `notBefore`), at most 731 days ahead. */
function checkPermitDate(
  day: LocalDate,
  today: LocalDate,
  notBefore?: LocalDate,
): void {
  const min =
    notBefore && notBefore > addDays(today, 1) ? notBefore : addDays(today, 1);
  const max = addDays(today, MAX_PERMIT_DAYS);
  if (day < min || day > max)
    throw invalid([
      {
        field: 'permitValidUntil',
        code: FieldErrorCode.PERMIT_DATE_OUT_OF_RANGE,
        params: { min, max },
      },
    ]);
}

const changed = (vehicle: Vehicle) =>
  appError.conflict(
    ErrorCode.VEHICLE_CHANGED,
    'The vehicle changed since it was read',
    { params: { version: vehicle.version } },
  );

/** The same answer as the unique index's: the number was issued already. */
const stickerTaken = () =>
  appError.conflict(ErrorCode.DUPLICATE_RESOURCE, 'Sticker already issued', {
    fields: [{ field: 'stickerNumber', code: FieldErrorCode.DUPLICATE_VALUE }],
  });
