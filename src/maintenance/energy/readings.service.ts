import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type Meter, type MeterReading } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
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
import { Notifier } from '../../core/notifications/notifier';
import { dbNow } from '../db-clock';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  addDays,
  dateColumn,
  ofDateColumn,
  type LocalDate,
} from '../schedules/local-dates';
import { TicketAccess } from '../tickets/ticket-access';
import { EnergySettingsService } from './energy-settings.service';
import type { MeterMode } from './meter-rules';
import { MetersService, meterNotFound } from './meters.service';
import {
  expectedRange,
  meanRate,
  neighbourProblem,
  periods,
  READING_PAST_DAYS,
  spike,
  type NeighbourProblem,
  type ReadingPoint,
  type ReadingSource,
} from './reading-rules';

export const READING_RESOURCE = 'meter_reading';

export interface ReadingInput {
  readOn: LocalDate;
  value: string;
  reset?: boolean;
}

export interface CorrectionInput {
  readOn?: LocalDate;
  value: string;
  reset?: boolean;
  reasonCode?: string;
}

/** What a technician sees of a meter they read (ADR 0066): nothing more. */
export interface MeterToRead {
  meter: Meter;
  unitCode: string | null;
  areaCode: string | null;
  last: { readOn: LocalDate; value: Prisma.Decimal } | null;
  expected: { from: string; to: string | null } | null;
}

const PAGE = keysetCursor('readOn', 'desc');

export const readingNotFound = () =>
  appError.notFound(ErrorCode.READING_NOT_FOUND, 'Reading not found');
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid reading', {
    fields,
  });
const exists = (readingId: string) =>
  appError.conflict(
    ErrorCode.READING_EXISTS,
    'The meter has a reading that day',
    { params: { readingId } },
  );

const point = (r: MeterReading): ReadingPoint => ({
  readOn: ofDateColumn(r.readOn),
  value: r.value,
  reset: r.reset,
});

/**
 * A meter's readings (ADR 0066). Every write takes the caller's account
 * FOR SHARE, then the meter FOR UPDATE, before it reads the meter's live
 * readings: two readings, a correction or an import on one meter are
 * decided one after the other, never against a stale view. A reading is
 * a day of the compound's calendar, not in the future and at most
 * READING_PAST_DAYS back; one live reading a day (READING_EXISTS). A
 * cumulative register is checked against the live readings on both sides
 * (READING_BELOW_PREVIOUS, READING_ABOVE_NEXT), a reset ending the check on
 * its side. A correction supersedes a reading once, with a reason; a
 * withdrawal supersedes it with nothing after it. The latest reading of a
 * meter may raise a spike alert, once per meter and day, to who keeps the
 * meters.
 */
@Injectable()
export class ReadingsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly access: TicketAccess,
    private readonly meters: MetersService,
    private readonly calendar: CompoundCalendar,
    private readonly settings: EnergySettingsService,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly community: CommunityMaintenancePort,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(READING_RESOURCE, (id) => this.one(id));
  }

  list(
    meterId: string,
    q: { cursor?: string; limit?: number; superseded?: 'true' | 'false' },
  ): Promise<Page<MeterReading>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.meter.findUnique({ where: { id: meterId } })))
        throw meterNotFound();
      const rows = await tx.meterReading.findMany({
        where: {
          AND: [
            { meterId },
            q.superseded === 'true' ? {} : { supersededAt: null },
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  one(id: string): Promise<MeterReading> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const r = await tx.meterReading.findUnique({ where: { id } });
      if (!r) throw readingNotFound();
      return r;
    });
  }

  /** A new reading by hand or by a technician. */
  record(
    meterId: string,
    input: ReadingInput,
    source: Exclude<ReadingSource, 'import'>,
  ): Promise<MeterReading> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: READING_RESOURCE, id });
      await this.access.lockSelf(tx);
      const meter = await this.meters.lockActive(tx, meterId);
      const { today } = await this.calendar.now(tx);
      const r = this.parse(input, today);
      const problem = await this.check(tx, meter, r);
      if (problem) throw problemError(problem);
      return this.insert(tx, meter, id, r, { source });
    });
  }

  /**
   * Checks a reading of a meter locked FOR UPDATE against its live
   * readings: the day free, the register in order. For the imports, which
   * report it by line.
   */
  async check(
    tx: TenantTxClient,
    meter: Meter,
    r: { readOn: LocalDate; value: Prisma.Decimal; reset: boolean },
    except?: string,
  ): Promise<ReadingProblem | null> {
    const day = dateColumn(r.readOn);
    const live = { meterId: meter.id, supersededAt: null };
    const same = await tx.meterReading.findFirst({
      where: {
        ...live,
        readOn: day,
        ...(except ? { NOT: { id: except } } : {}),
      },
      select: { id: true },
    });
    if (same) return { code: 'READING_EXISTS', params: { readingId: same.id } };
    const previous = await tx.meterReading.findFirst({
      where: { ...live, readOn: { lt: day } },
      orderBy: { readOn: 'desc' },
    });
    const next = await tx.meterReading.findFirst({
      where: { ...live, readOn: { gt: day } },
      orderBy: { readOn: 'asc' },
    });
    return neighbourProblem(
      meter.mode as MeterMode,
      r,
      previous && point(previous),
      next && point(next),
    );
  }

  /** Inserts a checked reading, then looks for a spike if it is the meter's latest. */
  async insert(
    tx: TenantTxClient,
    meter: Meter,
    id: string,
    r: { readOn: LocalDate; value: Prisma.Decimal; reset: boolean },
    by: { source: ReadingSource; importId?: string; supersedesId?: string },
  ): Promise<MeterReading> {
    const row = await tx.meterReading.create({
      data: {
        id,
        tenantId: this.ctx.tenantId,
        meterId: meter.id,
        readOn: dateColumn(r.readOn),
        value: r.value,
        reset: r.reset,
        source: by.source,
        importId: by.importId ?? null,
        supersedesId: by.supersedesId ?? null,
        recordedById: this.ctx.accountId,
      },
    });
    await this.alertOnSpike(tx, meter, row);
    return row;
  }

  /** A live reading corrected, once, with a reason: a new reading supersedes it. */
  correct(
    meterId: string,
    readingId: string,
    input: CorrectionInput,
  ): Promise<MeterReading> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.readingCorrect,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: READING_RESOURCE, id });
      await this.access.lockSelf(tx);
      const meter = await this.meters.lock(tx, meterId);
      const old = await this.live(tx, meter.id, readingId);
      const { today } = await this.calendar.now(tx);
      const r = this.parse(
        {
          readOn: input.readOn ?? ofDateColumn(old.readOn),
          value: input.value,
          reset: input.reset ?? old.reset,
        },
        today,
      );
      const problem = await this.check(tx, meter, r, old.id);
      if (problem) throw problemError(problem);
      await this.supersede(tx, old.id, reason);
      const row = await this.insert(tx, meter, id, r, {
        source: 'manual',
        supersedesId: old.id,
      });
      await this.audit.record(tx, {
        action: 'meter_reading.corrected',
        targetId: row.id,
        metadata: {
          meterId: meter.id,
          supersedesId: old.id,
          readOn: r.readOn,
          value: row.value.toFixed(4),
          reset: r.reset,
          reasonCode: reason,
        },
      });
      return row;
    });
  }

  /** A live reading withdrawn, once, with a reason: nothing takes its place. */
  withdraw(
    meterId: string,
    readingId: string,
    reasonCode?: string,
  ): Promise<MeterReading> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.readingCorrect,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const meter = await this.meters.lock(tx, meterId);
      const old = await this.live(tx, meter.id, readingId);
      const row = await this.supersede(tx, old.id, reason);
      await this.audit.record(tx, {
        action: 'meter_reading.withdrawn',
        targetId: old.id,
        metadata: {
          meterId: meter.id,
          readOn: ofDateColumn(old.readOn),
          reasonCode: reason,
        },
      });
      return row;
    });
  }

  /**
   * What a technician sees of a meter they read (ADR 0066): the meter, its
   * last live reading and the range today's reading is expected in. Never
   * the meter's history or its use.
   */
  toRead(meterId: string): Promise<MeterToRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const meter = await tx.meter.findUnique({ where: { id: meterId } });
      if (!meter) throw meterNotFound();
      const unit = meter.unitId
        ? await this.community.unit(tx, meter.unitId)
        : null;
      const area = meter.commonAreaId
        ? await tx.commonArea.findUnique({
            where: { id: meter.commonAreaId },
            select: { code: true },
          })
        : null;
      const { today } = await this.calendar.now(tx);
      const rules = await this.settings.inTx(tx);
      const recent = (
        await tx.meterReading.findMany({
          where: { meterId, supersededAt: null },
          orderBy: { readOn: 'desc' },
          take: rules.anomalyPeriods + 1,
        })
      )
        .reverse()
        .map(point);
      const last = recent.at(-1) ?? null;
      const mean = meanRate(
        periods(meter.mode as MeterMode, meter.multiplier, recent),
      );
      return {
        meter,
        unitCode: unit?.code ?? null,
        areaCode: area?.code ?? null,
        last: last && { readOn: last.readOn, value: last.value },
        expected: expectedRange(
          meter.mode as MeterMode,
          meter.multiplier,
          last,
          mean,
          today,
          rules.anomalyFactor,
        ),
      };
    });
  }

  /** A reading's day and value as entered: a real day, by today, at most a while back. */
  parse(
    input: { readOn: LocalDate; value: string; reset?: boolean },
    today: LocalDate,
  ): { readOn: LocalDate; value: Prisma.Decimal; reset: boolean } {
    if (
      input.readOn > today ||
      input.readOn < addDays(today, -READING_PAST_DAYS)
    )
      throw invalid([
        {
          field: 'readOn',
          code: FieldErrorCode.INVALID_VALUE,
          params: { maxDaysBack: READING_PAST_DAYS },
        },
      ]);
    return {
      readOn: input.readOn,
      value: new Prisma.Decimal(input.value),
      reset: input.reset ?? false,
    };
  }

  private async live(
    tx: TenantTxClient,
    meterId: string,
    readingId: string,
  ): Promise<MeterReading> {
    const r = await tx.meterReading.findUnique({ where: { id: readingId } });
    if (!r || r.meterId !== meterId) throw readingNotFound();
    if (r.supersededAt)
      throw appError.conflict(
        ErrorCode.READING_ALREADY_CORRECTED,
        'This reading was corrected or withdrawn already',
      );
    return r;
  }

  private async supersede(
    tx: TenantTxClient,
    id: string,
    reason: string,
  ): Promise<MeterReading> {
    return tx.meterReading.update({
      where: { id },
      data: {
        supersededAt: await dbNow(tx),
        supersededById: this.ctx.accountId,
        supersededReason: reason,
      },
    });
  }

  /**
   * A spike (ADR 0066), looked for on the meter's latest live reading only
   * — a backdated reading raises nothing: the period up to it against the
   * mean of the compound's number of periods before, times its factor.
   * Once per meter and day (the unique key, ON CONFLICT DO NOTHING), told
   * to who keeps the meters.
   */
  private async alertOnSpike(
    tx: TenantTxClient,
    meter: Meter,
    row: MeterReading,
  ): Promise<void> {
    const later = await tx.meterReading.findFirst({
      where: {
        meterId: meter.id,
        supersededAt: null,
        readOn: { gt: row.readOn },
      },
      select: { id: true },
    });
    if (later) return;
    const rules = await this.settings.inTx(tx);
    const recent = (
      await tx.meterReading.findMany({
        where: {
          meterId: meter.id,
          supersededAt: null,
          readOn: { lte: row.readOn },
        },
        orderBy: { readOn: 'desc' },
        take: rules.anomalyPeriods + 2,
      })
    )
      .reverse()
      .map(point);
    const found = spike(
      periods(meter.mode as MeterMode, meter.multiplier, recent),
      rules.anomalyPeriods,
      rules.anomalyFactor,
    );
    if (!found) return;
    const inserted = await tx.$executeRaw`
      INSERT INTO meter_alerts (id, tenant_id, meter_id, reading_id, read_on, kind, daily_rate, baseline_rate)
      VALUES (${newId()}::uuid, ${this.ctx.tenantId}::uuid, ${meter.id}::uuid, ${row.id}::uuid,
              ${ofDateColumn(row.readOn)}::date, 'spike',
              ${found.rate.toDecimalPlaces(4).toFixed(4)}::numeric,
              ${found.baseline.toDecimalPlaces(4).toFixed(4)}::numeric)
      ON CONFLICT (tenant_id, meter_id, read_on) DO NOTHING`;
    if (!inserted) return;
    const keepers = await this.staff.holding(tx, 'energy.manage');
    await this.notifier.notify(
      tx,
      keepers.map((k) => k.id),
      {
        kind: 'meter.anomaly',
        params: { meterRef: meter.code, readOn: ofDateColumn(row.readOn) },
        targetId: meter.id,
      },
    );
  }
}

export type ReadingProblem =
  NeighbourProblem | { code: 'READING_EXISTS'; params: { readingId: string } };

/** A problem as the API answers it on one reading. */
export function problemError(p: ReadingProblem) {
  if (p.code === 'READING_EXISTS') return exists(p.params.readingId);
  return invalid([
    { field: 'value', code: FieldErrorCode[p.code], params: p.params },
  ]);
}
