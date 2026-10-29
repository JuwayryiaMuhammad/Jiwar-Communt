import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type Meter } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
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
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { AssetsService } from '../assets/assets.service';
import { dbNow } from '../db-clock';
import { CommonAreasService } from '../locations/common-areas.service';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { dateColumn, type LocalDate } from '../schedules/local-dates';
import type { MeterKind, MeterMode } from './meter-rules';

export const METER_RESOURCE = 'meter';

export interface MeterInput {
  code: string;
  kind: MeterKind;
  mode?: MeterMode;
  multiplier?: string;
  unitId?: string;
  commonAreaId?: string;
  assetId?: string;
  serial?: string;
  installedOn?: LocalDate;
}

export interface MeterUpdate {
  serial?: string | null;
  installedOn?: LocalDate | null;
}

export interface MetersQuery {
  kind?: MeterKind;
  unitId?: string;
  commonAreaId?: string;
  active?: 'true' | 'false';
  cursor?: string;
  limit?: number;
}

const PAGE = keysetCursor('createdAt', 'asc');

export const meterNotFound = () =>
  appError.notFound(ErrorCode.METER_NOT_FOUND, 'Meter not found');
export const meterRetired = () =>
  appError.conflict(ErrorCode.METER_RETIRED, 'This meter is retired');
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid meter', {
    fields,
  });

/**
 * The compound's meters (ADR 0066), kept with `energy.manage`. A meter is
 * in a unit or a common area, or on an asset (and then where the asset
 * stands). Its code, kind, mode, multiplier and place never change — a
 * trigger holds them — so every reading keeps the meaning it was given; a
 * meter that is replaced is retired and a new one added, or it takes a
 * reset reading. Retired once, with a reason; never deleted. A duplicate
 * code is DUPLICATE_RESOURCE on `code` (db-constraints).
 */
@Injectable()
export class MetersService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityMaintenancePort,
    private readonly areas: CommonAreasService,
    private readonly assets: AssetsService,
    private readonly calendar: CompoundCalendar,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(METER_RESOURCE, (id) => this.get(id));
  }

  list(q: MetersQuery): Promise<Page<Meter>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.meter.findMany({
        where: {
          AND: [
            q.kind ? { kind: q.kind } : {},
            q.unitId ? { unitId: q.unitId } : {},
            q.commonAreaId ? { commonAreaId: q.commonAreaId } : {},
            q.active ? { active: q.active === 'true' } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<Meter> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const meter = await tx.meter.findUnique({ where: { id } });
      if (!meter) throw meterNotFound();
      return meter;
    });
  }

  create(input: MeterInput): Promise<Meter> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: METER_RESOURCE, id });
      const place = await this.place(tx, input);
      const { today } = await this.calendar.now(tx);
      const fields: FieldError[] = [];
      if (input.multiplier !== undefined && Number(input.multiplier) <= 0)
        fields.push({
          field: 'multiplier',
          code: FieldErrorCode.INVALID_VALUE,
        });
      if (input.installedOn !== undefined && input.installedOn > today)
        fields.push({
          field: 'installedOn',
          code: FieldErrorCode.INVALID_VALUE,
        });
      if (fields.length) throw invalid(fields);
      const meter = await tx.meter.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          code: input.code,
          kind: input.kind,
          mode: input.mode ?? 'cumulative',
          multiplier: new Prisma.Decimal(input.multiplier ?? '1'),
          ...place,
          serial: input.serial?.trim() || null,
          installedOn:
            input.installedOn === undefined
              ? null
              : dateColumn(input.installedOn),
          createdById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'meter.created',
        targetId: id,
        changes: diffChanges(null, audited(meter), 'meter.created'),
      });
      return meter;
    });
  }

  /** Its serial and installation day, while it is in service. */
  update(id: string, input: MeterUpdate): Promise<Meter> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      if (!before.active) throw meterRetired();
      if (input.installedOn) {
        const { today } = await this.calendar.now(tx);
        if (input.installedOn > today)
          throw invalid([
            { field: 'installedOn', code: FieldErrorCode.INVALID_VALUE },
          ]);
      }
      const meter = await tx.meter.update({
        where: { id },
        data: {
          serial:
            input.serial === undefined
              ? undefined
              : input.serial?.trim() || null,
          installedOn:
            input.installedOn === undefined
              ? undefined
              : input.installedOn === null
                ? null
                : dateColumn(input.installedOn),
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(meter),
        'meter.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'meter.updated',
          targetId: id,
          changes,
        });
      return meter;
    });
  }

  /** Out of service for good, with a reason; its readings stay. */
  retire(id: string, reasonCode?: string): Promise<Meter> {
    const reason = requireReasonCodeOnly(reasonCode, REASON_CODES.meterRetire);
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      if (!before.active) throw meterRetired();
      const meter = await tx.meter.update({
        where: { id },
        data: {
          active: false,
          retiredAt: await dbNow(tx),
          retiredById: this.ctx.accountId,
          retireReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'meter.retired',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      return meter;
    });
  }

  /**
   * The meter locked FOR UPDATE: every reading, correction and import
   * takes it before it reads the meter's readings, so the checks against
   * the neighbours never see a stale view (ADR 0066). METER_NOT_FOUND.
   */
  async lock(tx: TenantTxClient, id: string): Promise<Meter> {
    await tx.$queryRaw`SELECT id FROM meters WHERE id = ${id}::uuid FOR UPDATE`;
    const meter = await tx.meter.findUnique({ where: { id } });
    if (!meter) throw meterNotFound();
    return meter;
  }

  /** Locked, and in service: METER_RETIRED. */
  async lockActive(tx: TenantTxClient, id: string): Promise<Meter> {
    const meter = await this.lock(tx, id);
    if (!meter.active) throw meterRetired();
    return meter;
  }

  /**
   * Where a new meter stands: a unit, a common area, or an asset's place
   * (the asset not retired, shared-locked). Exactly one of the three is
   * named.
   */
  private async place(
    tx: TenantTxClient,
    input: MeterInput,
  ): Promise<{
    unitId: string | null;
    commonAreaId: string | null;
    assetId: string | null;
  }> {
    const named = [input.unitId, input.commonAreaId, input.assetId].filter(
      (v) => v !== undefined,
    ).length;
    if (named === 0)
      throw invalid([{ field: 'unitId', code: FieldErrorCode.FIELD_REQUIRED }]);
    if (named > 1)
      throw invalid([
        {
          field: input.assetId !== undefined ? 'assetId' : 'commonAreaId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        },
      ]);
    if (input.assetId !== undefined) {
      const asset = await this.assets.requireActive(tx, input.assetId);
      return {
        unitId: asset.unitId,
        commonAreaId: asset.commonAreaId,
        assetId: asset.id,
      };
    }
    if (input.unitId !== undefined) {
      if (!(await this.community.unit(tx, input.unitId)))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      return { unitId: input.unitId, commonAreaId: null, assetId: null };
    }
    await this.areas.requireActive(tx, input.commonAreaId!);
    return { unitId: null, commonAreaId: input.commonAreaId!, assetId: null };
  }
}

const audited = (m: Meter) => ({
  code: m.code,
  kind: m.kind,
  mode: m.mode,
  multiplier: m.multiplier.toFixed(4),
  unitId: m.unitId,
  commonAreaId: m.commonAreaId,
  assetId: m.assetId,
  serial: m.serial,
  installedOn: m.installedOn?.toISOString().slice(0, 10) ?? null,
  active: m.active,
});
