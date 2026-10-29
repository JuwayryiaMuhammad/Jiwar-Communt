import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type EnergyMeasure } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
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
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  addDays,
  dateColumn,
  daysBetween,
  ofDateColumn,
  ofDateColumnOrNull,
  type LocalDate,
} from '../schedules/local-dates';
import { ConsumptionService } from './consumption.service';
import { amount, MEASURE_WEEKS, measureWindows } from './consumption-rules';
import type { MeterKind } from './meter-rules';

export const MEASURE_RESOURCE = 'energy_measure';
/** How far ahead a measure may be planned. */
export const MEASURE_AHEAD_DAYS = 366;

export interface MeasureInput {
  title: string;
  kind: MeterKind;
  meterId?: string;
  building?: string;
  startsOn: LocalDate;
  cost?: string;
}

/** A measure's effect, read now (ADR 0066). */
export interface MeasureEffect {
  weeks: number;
  before: { from: LocalDate; to: LocalDate; perDay: string };
  after: { from: LocalDate; to: LocalDate; perDay: string } | null;
  /** The after side has all its days. */
  complete: boolean;
  /** (after − before) / before a day, as a percentage; null without a before or an after. */
  changePct: string | null;
}

const PAGE = keysetCursor('startsOn', 'desc');

export const measureNotFound = () =>
  appError.notFound(ErrorCode.ENERGY_MEASURE_NOT_FOUND, 'Measure not found');
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid measure', {
    fields,
  });

/**
 * Saving measures (ADR 0066): something done to use less — on one meter,
 * one building or the whole compound — from a day, kept with
 * `energy.manage`. Its effect is read, never stored: the use a day over
 * whole weeks before its start against the same weeks from it, so both
 * sides hold the same days of the week. Ended once, on a day not before
 * it started and by today.
 */
@Injectable()
export class MeasuresService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly calendar: CompoundCalendar,
    private readonly community: CommunityMaintenancePort,
    private readonly consumption: ConsumptionService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(MEASURE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) => this.find(tx, id)),
    );
  }

  list(q: { cursor?: string; limit?: number }): Promise<Page<EnergyMeasure>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.energyMeasure.findMany({
        where: { AND: [...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  /** A measure and its effect over `weeks` weeks each side. */
  get(
    id: string,
    weeks: number = MEASURE_WEEKS.default,
  ): Promise<{ measure: EnergyMeasure; effect: MeasureEffect }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const measure = await this.find(tx, id);
      const { today } = await this.calendar.now(tx);
      return { measure, effect: await this.effect(tx, measure, weeks, today) };
    });
  }

  create(input: MeasureInput): Promise<EnergyMeasure> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: MEASURE_RESOURCE, id });
      const { today } = await this.calendar.now(tx);
      const fields: FieldError[] = [];
      if (input.meterId !== undefined && input.building !== undefined)
        fields.push({
          field: 'building',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      if (input.startsOn > addDays(today, MEASURE_AHEAD_DAYS))
        fields.push({
          field: 'startsOn',
          code: FieldErrorCode.INVALID_VALUE,
          params: { maxDaysAhead: MEASURE_AHEAD_DAYS },
        });
      if (fields.length) throw invalid(fields);
      if (input.meterId !== undefined) {
        const meter = await tx.meter.findUnique({
          where: { id: input.meterId },
        });
        if (!meter || meter.kind !== input.kind)
          throw invalid([
            { field: 'meterId', code: FieldErrorCode.METER_NOT_AVAILABLE },
          ]);
      }
      if (
        input.building !== undefined &&
        !(await this.community.hasBuilding(tx, input.building.trim()))
      )
        throw invalid([
          { field: 'building', code: FieldErrorCode.BUILDING_NOT_FOUND },
        ]);
      const measure = await tx.energyMeasure.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          title: input.title.trim(),
          kind: input.kind,
          meterId: input.meterId ?? null,
          building: input.building?.trim() ?? null,
          startsOn: dateColumn(input.startsOn),
          cost:
            input.cost === undefined ? null : new Prisma.Decimal(input.cost),
          createdById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'energy_measure.created',
        targetId: id,
        metadata: {
          kind: input.kind,
          meterId: measure.meterId,
          building: measure.building,
          startsOn: input.startsOn,
          cost: measure.cost?.toFixed(2) ?? null,
        },
      });
      return measure;
    });
  }

  /** Ended, once, on a day from its start to today. */
  end(id: string, endedOn: LocalDate): Promise<EnergyMeasure> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM energy_measures WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await this.find(tx, id);
      if (before.endedAt)
        throw appError.conflict(
          ErrorCode.ENERGY_MEASURE_ENDED,
          'This measure is ended already',
        );
      const { today } = await this.calendar.now(tx);
      if (endedOn < ofDateColumn(before.startsOn) || endedOn > today)
        throw invalid([
          { field: 'endedOn', code: FieldErrorCode.INVALID_VALUE },
        ]);
      const measure = await tx.energyMeasure.update({
        where: { id },
        data: {
          endedOn: dateColumn(endedOn),
          endedAt: await dbNow(tx),
          endedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'energy_measure.ended',
        targetId: id,
        metadata: { endedOn },
      });
      return measure;
    });
  }

  private async find(tx: TenantTxClient, id: string): Promise<EnergyMeasure> {
    const m = await tx.energyMeasure.findUnique({ where: { id } });
    if (!m) throw measureNotFound();
    return m;
  }

  private async effect(
    tx: TenantTxClient,
    m: EnergyMeasure,
    weeks: number,
    today: LocalDate,
  ): Promise<MeasureEffect> {
    const ended = ofDateColumnOrNull(m.endedOn);
    const until = ended && ended < today ? ended : today;
    const w = measureWindows(ofDateColumn(m.startsOn), weeks, until);
    const scope = { meterId: m.meterId, building: m.building };
    const kind = m.kind as MeterKind;
    const perDay = async (x: { from: LocalDate; to: LocalDate }) =>
      (await this.consumption.useOver(tx, kind, scope, x)).dividedBy(
        daysBetween(x.from, x.to) + 1,
      );
    const before = await perDay(w.before);
    const after = w.after ? await perDay(w.after) : null;
    return {
      weeks,
      before: { ...w.before, perDay: amount(before) },
      after: w.after && after ? { ...w.after, perDay: amount(after) } : null,
      complete: w.complete,
      changePct:
        after && before.gt(0)
          ? after.minus(before).dividedBy(before).times(100).toFixed(1)
          : null,
    };
  }
}
