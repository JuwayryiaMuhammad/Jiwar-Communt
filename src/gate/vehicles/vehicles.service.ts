import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Vehicle, VehicleType } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import {
  runAfterCommit,
  type AfterCommit,
} from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  normalizePlate,
  PLATE_MAX,
  plateKey,
} from '../../core/common/vehicle-plate';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import {
  unitNotFound,
  VEHICLE_RESOURCE,
  VehicleCore,
  vehicleNotFound,
} from './vehicle-core';
import {
  COLOR,
  dayOf,
  MAKE_AND_MODEL,
  permitStatus,
  type PermitStatus,
} from './vehicle-rules';
import { VehicleView } from './views/vehicle.views';

export interface NewVehicle {
  plate: string;
  makeAndModel: string;
  color: string;
  type: VehicleType;
  licencePhotoFileId?: string;
}

export interface VehicleChange {
  plate?: string;
  makeAndModel?: string;
  color?: string;
  type?: VehicleType;
  /** A new photo replaces the old one; null removes it. */
  licencePhotoFileId?: string | null;
}

/** A vehicle as a resident sees it, assembled in the read's transaction. */
export interface ResidentVehicle {
  vehicle: Vehicle;
  permitStatus: PermitStatus;
  photo: PresignedRead | null;
  /** The caller registered it or is the unit's primary: may edit, remove. */
  canManage: boolean;
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

/** A text field trimmed and in range, else its field error. */
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

function plateOf(raw: string, fields: FieldError[]): string {
  const plate = normalizePlate(raw);
  if (!plate)
    fields.push({
      field: 'plate',
      code: FieldErrorCode.INVALID_FORMAT,
      params: { maxLength: PLATE_MAX },
    });
  return plate ?? '';
}

/**
 * A unit's vehicles as its people keep them (ADR 0045). Whoever holds
 * `vehicles` on the unit (someone who lives there, or an adult member with
 * an account) sees them and registers one; its registrant or the unit's
 * primary edits or removes it. A new vehicle, or one whose plate changed,
 * waits for the staff (`pending`); colour, model and type keep its status.
 */
@Injectable()
export class VehiclesService implements OnModuleInit {
  private readonly logger = new Logger(VehiclesService.name);

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly files: FilesService,
    private readonly community: CommunityGatePort,
    private readonly core: VehicleCore,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(VEHICLE_RESOURCE, async (id) =>
      VehicleView.from(await this.get(id)),
    );
  }

  list(unitId: string): Promise<ResidentVehicle[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requireVehicles(tx, unitId);
      const rows = await tx.vehicle.findMany({
        where: { unitId, status: { not: 'removed' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return this.views(tx, unitId, rows);
    });
  }

  get(id: string): Promise<ResidentVehicle> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const vehicle = await this.visible(tx, id);
      return (await this.views(tx, vehicle.unitId, [vehicle]))[0];
    });
  }

  /**
   * Registers a vehicle for the unit, `pending`. At most the compound's
   * `maxVehiclesPerUnit` pending or active vehicles per unit, counted
   * under the unit's vehicles lock (VEHICLE_LIMIT_REACHED).
   */
  create(unitId: string, input: NewVehicle): Promise<ResidentVehicle> {
    const fields: FieldError[] = [];
    const plate = plateOf(input.plate, fields);
    const makeAndModel = text(
      'makeAndModel',
      input.makeAndModel,
      MAKE_AND_MODEL,
      fields,
    );
    const color = text('color', input.color, COLOR, fields);
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: VEHICLE_RESOURCE, id });
      await this.core.lockSelf(tx);
      await this.requireVehicles(tx, unitId);
      await this.core.lockUnitVehicles(tx, unitId);
      await this.checkLimit(tx, unitId, null);
      const photo = input.licencePhotoFileId
        ? await this.claimPhoto(tx, input.licencePhotoFileId)
        : null;
      const number = await this.core.nextNumber(tx, 'vehicle');
      const vehicle = await tx.vehicle.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          unitId,
          registeredById: this.ctx.accountId,
          plate,
          makeAndModel,
          color,
          type: input.type,
          licencePhotoFileId: photo,
        },
      });
      await this.audit.record(tx, {
        action: 'vehicle.registered',
        targetId: id,
        metadata: {
          unitId,
          number,
          type: input.type,
          licencePhoto: photo !== null,
        },
      });
      return (await this.views(tx, unitId, [vehicle]))[0];
    });
  }

  /**
   * Edits a vehicle (its registrant or the unit's primary). A new plate —
   * one that is not the same plate tidied differently — sends it back to
   * `pending`: its sticker is void and its permit gone, and the staff
   * decide again (`version` + 1). A rejected vehicle given a new plate
   * waits again, within the unit's limit.
   */
  update(id: string, input: VehicleChange): Promise<ResidentVehicle> {
    const fields: FieldError[] = [];
    const plate =
      input.plate !== undefined ? plateOf(input.plate, fields) : undefined;
    const makeAndModel =
      input.makeAndModel !== undefined
        ? text('makeAndModel', input.makeAndModel, MAKE_AND_MODEL, fields)
        : undefined;
    const color =
      input.color !== undefined
        ? text('color', input.color, COLOR, fields)
        : undefined;
    if (fields.length) throw invalid(fields);
    const after: AfterCommit[] = [];
    return this.tenantTx
      .withTenantTx(async (tx) => {
        await this.core.lockSelf(tx);
        const seen = await this.manageable(tx, id);
        await this.core.lockUnitVehicles(tx, seen.unitId);
        const before = await this.lockRow(tx, id);
        const newPlate =
          plate !== undefined && plateKey(plate) !== before.plateKey
            ? plate
            : undefined;
        if (newPlate && before.status === 'rejected')
          await this.checkLimit(tx, before.unitId, before.id);
        const data: Parameters<typeof tx.vehicle.update>[0]['data'] = {
          ...(plate !== undefined ? { plate } : {}),
          ...(makeAndModel !== undefined ? { makeAndModel } : {}),
          ...(color !== undefined ? { color } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(newPlate
            ? {
                status: 'pending' as const,
                stickerNumber: null,
                permitValidUntil: null,
                rejectionReason: null,
                version: before.version + 1,
              }
            : {}),
        };
        if (input.licencePhotoFileId !== undefined) {
          const next = input.licencePhotoFileId
            ? await this.claimPhoto(tx, input.licencePhotoFileId)
            : null;
          data.licencePhotoFileId = next;
          const old = before.licencePhotoFileId;
          if (old && old !== next) {
            await this.files.markDeleted(
              tx,
              { id: old, purpose: 'vehicle_licence' },
              next ? 'replaced' : 'owner',
            );
            after.push(() => this.files.purge(old).then(() => undefined));
          }
        }
        const vehicle = await tx.vehicle.update({ where: { id }, data });
        if (newPlate)
          await this.audit.record(tx, {
            action: 'vehicle.plate_changed',
            targetId: id,
            changes: { plate: { changed: true } },
            metadata: {
              unitId: vehicle.unitId,
              previousStatus: before.status,
              version: vehicle.version,
            },
          });
        const changes = diffChanges(
          {
            makeAndModel: before.makeAndModel,
            color: before.color,
            type: before.type,
            licencePhoto: before.licencePhotoFileId,
            ...(newPlate ? {} : { plate: before.plate }),
          },
          {
            makeAndModel: vehicle.makeAndModel,
            color: vehicle.color,
            type: vehicle.type,
            licencePhoto: vehicle.licencePhotoFileId,
            ...(newPlate ? {} : { plate: vehicle.plate }),
          },
          'vehicle.updated',
        );
        if (Object.keys(changes).length)
          await this.audit.record(tx, {
            action: 'vehicle.updated',
            targetId: id,
            changes,
            metadata: { unitId: vehicle.unitId },
          });
        return (await this.views(tx, vehicle.unitId, [vehicle]))[0];
      })
      .then(async (view) => {
        await runAfterCommit(after, this.logger);
        return view;
      });
  }

  /**
   * Removes a vehicle (its registrant or the unit's primary): final. Its
   * sticker and permit are void; the licence photo goes 30 days later.
   */
  remove(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode ?? 'other',
      REASON_CODES.vehicleRemove,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      await this.manageable(tx, id);
      const before = await this.lockRow(tx, id);
      const now = new Date();
      await tx.vehicle.update({
        where: { id },
        data: {
          status: 'removed',
          stickerNumber: null,
          permitValidUntil: null,
          rejectionReason: null,
          removedAt: now,
          removedById: this.ctx.accountId,
          removalSide: 'resident',
          removalReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'vehicle.removed',
        targetId: id,
        metadata: {
          unitId: before.unitId,
          side: 'resident',
          reasonCode: reason,
          previousStatus: before.status,
        },
      });
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** The caller holds `vehicles` on the unit, or the matching refusal. */
  private async requireVehicles(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<void> {
    const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
    if (!caps?.unitView) throw unitNotFound();
    if (!caps.vehicles)
      throw appError.forbidden(
        ErrorCode.VEHICLES_NOT_ALLOWED,
        'Not allowed to register vehicles for this unit',
      );
  }

  /** A vehicle the caller sees: not removed, on a unit where they hold `vehicles`. */
  private async visible(tx: TenantTxClient, id: string): Promise<Vehicle> {
    const vehicle = await tx.vehicle.findUnique({ where: { id } });
    if (!vehicle || vehicle.status === 'removed') throw vehicleNotFound();
    const caps = await this.community.placeIn(
      tx,
      this.ctx.accountId,
      vehicle.unitId,
    );
    if (!caps?.vehicles) throw vehicleNotFound();
    return vehicle;
  }

  /** A vehicle the caller sees and may change: its registrant or the primary. */
  private async manageable(tx: TenantTxClient, id: string): Promise<Vehicle> {
    const vehicle = await this.visible(tx, id);
    if (!(await this.canManage(tx, vehicle)))
      throw appError.forbidden(
        ErrorCode.VEHICLE_ACTION_NOT_ALLOWED,
        'Only its registrant or the unit’s primary changes a vehicle',
      );
    return vehicle;
  }

  private async canManage(
    tx: TenantTxClient,
    vehicle: Vehicle,
  ): Promise<boolean> {
    return (
      vehicle.registeredById === this.ctx.accountId ||
      this.community.isPrimary(tx, vehicle.unitId, this.ctx.accountId)
    );
  }

  /** The vehicle's row, locked; a removed one is gone. */
  private async lockRow(tx: TenantTxClient, id: string): Promise<Vehicle> {
    await tx.$queryRaw`SELECT id FROM vehicles WHERE id = ${id}::uuid FOR UPDATE`;
    const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id } });
    if (vehicle.status === 'removed') throw vehicleNotFound();
    return vehicle;
  }

  /** Under the unit's vehicles lock: room for one more pending or active vehicle. */
  private async checkLimit(
    tx: TenantTxClient,
    unitId: string,
    except: string | null,
  ): Promise<void> {
    const { maxVehiclesPerUnit: max } = await this.core.settings(tx);
    const held = await tx.vehicle.count({
      where: {
        unitId,
        status: { in: ['pending', 'active'] },
        ...(except ? { id: { not: except } } : {}),
      },
    });
    if (held >= max)
      throw appError.conflict(
        ErrorCode.VEHICLE_LIMIT_REACHED,
        'The unit has as many vehicles as the compound allows',
        { params: { max } },
      );
  }

  /** The caller's finalized licence photo, attached to the vehicle. */
  private async claimPhoto(
    tx: TenantTxClient,
    fileId: string,
  ): Promise<string> {
    const file = await this.files.claim(tx, fileId, 'vehicle_licence');
    if (!file)
      throw invalid([
        {
          field: 'licencePhotoFileId',
          code: FieldErrorCode.FILE_NOT_AVAILABLE,
        },
      ]);
    await this.files.attach(tx, file);
    return file.id;
  }

  private async views(
    tx: TenantTxClient,
    unitId: string,
    rows: Vehicle[],
  ): Promise<ResidentVehicle[]> {
    if (!rows.length) return [];
    const { today } = await this.core.clock(tx);
    const primary = await this.community.isPrimary(
      tx,
      unitId,
      this.ctx.accountId,
    );
    const out: ResidentVehicle[] = [];
    for (const vehicle of rows)
      out.push({
        vehicle,
        permitStatus: permitStatus(
          vehicle.status,
          dayOf(vehicle.permitValidUntil),
          today,
        ),
        photo: await this.files.readUrl(tx, vehicle.licencePhotoFileId),
        canManage: primary || vehicle.registeredById === this.ctx.accountId,
      });
    return out;
  }
}
