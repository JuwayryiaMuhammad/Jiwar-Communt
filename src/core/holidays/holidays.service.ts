import { Injectable } from '@nestjs/common';
import type { CompoundHoliday } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { RequestContext } from '../common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../common/errors';
import { addDays, localDate, type LocalDate } from '../common/slots/day-slots';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { TenantSettingsService } from '../tenant-settings/tenant-settings.service';
import {
  columnOfDay,
  dayOfColumn,
  flagOf,
  holidaysBetween,
  lockCalendar,
  MAX_UPCOMING_HOLIDAYS,
  type HolidayFlag,
} from './holiday-reads';

/** A read of the calendar covers at most a year and a day. */
export const HOLIDAY_READ_DAYS = 366;
/** A holiday is dated at most a year back and two years ahead. */
export const HOLIDAY_DAYS_BACK = 366;
export const HOLIDAY_DAYS_AHEAD = 731;

export interface NewHoliday {
  day: LocalDate;
  nameEn: string;
  nameAr: string;
  stopsWorks?: boolean;
}

export interface HolidayChange {
  nameEn?: string;
  nameAr?: string;
  stopsWorks?: boolean;
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

const notFound = () =>
  appError.notFound(ErrorCode.HOLIDAY_NOT_FOUND, 'Holiday not found');

/**
 * The compound's holiday calendar (ADR 0084), kept with `spaces.manage`.
 * Every write takes the calendar's row FOR UPDATE first: a permit request
 * holds it FOR SHARE while it decides on a day, so a new day off either
 * came before (and refuses it) or waits for it, as a change of the permits'
 * days off did (ADR 0049). The day is a holiday's key: one a day, never
 * moved (remove it and add another). Audited by day and whether it stops
 * works; the names are the management's own words, plain data.
 */
@Injectable()
export class HolidaysService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly settings: TenantSettingsService,
  ) {}

  /** The holidays from `from` (today by default) to `to` (a year on). */
  list(from?: LocalDate, to?: LocalDate): Promise<HolidayFlag[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const start = from ?? (await this.today(tx));
      const end = to ?? addDays(start, HOLIDAY_READ_DAYS - 1);
      if (end < start)
        throw invalid([
          { field: 'to', code: FieldErrorCode.ENDS_BEFORE_START },
        ]);
      if (end > addDays(start, HOLIDAY_READ_DAYS - 1))
        throw invalid([
          {
            field: 'to',
            code: FieldErrorCode.PERIOD_TOO_LONG,
            params: { maxDays: HOLIDAY_READ_DAYS },
          },
        ]);
      return holidaysBetween(tx, start, end);
    });
  }

  /** What the apps show: the holidays of the coming year, today included. */
  upcoming(): Promise<HolidayFlag[]> {
    return this.list();
  }

  create(input: NewHoliday): Promise<HolidayFlag> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.tenantId;
      await lockCalendar(tx, tenantId, 'update');
      const today = await this.today(tx);
      const min = addDays(today, -HOLIDAY_DAYS_BACK);
      const max = addDays(today, HOLIDAY_DAYS_AHEAD);
      if (input.day < min || input.day > max)
        throw invalid([
          {
            field: 'day',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { min, max },
          },
        ]);
      if (
        await tx.compoundHoliday.findUnique({
          where: {
            tenantId_day: { tenantId, day: columnOfDay(input.day) },
          },
          select: { id: true },
        })
      )
        throw appError.conflict(
          ErrorCode.HOLIDAY_EXISTS,
          'The compound has a holiday on that day already',
          { params: { day: input.day } },
        );
      if (
        input.day >= today &&
        (await tx.compoundHoliday.count({
          where: { day: { gte: columnOfDay(today) } },
        })) >= MAX_UPCOMING_HOLIDAYS
      )
        throw appError.conflict(
          ErrorCode.HOLIDAYS_TOO_MANY,
          'The calendar holds as many coming holidays as it may',
          { params: { max: MAX_UPCOMING_HOLIDAYS } },
        );
      const row = await tx.compoundHoliday.create({
        data: {
          id: newId(),
          tenantId,
          day: columnOfDay(input.day),
          nameEn: input.nameEn,
          nameAr: input.nameAr,
          stopsWorks: input.stopsWorks ?? true,
        },
      });
      await this.touch(tx, tenantId);
      await this.audit.record(tx, {
        action: 'holiday.created',
        targetId: row.id,
        metadata: { day: input.day, stopsWorks: row.stopsWorks },
      });
      return flagOf(row);
    });
  }

  update(id: string, input: HolidayChange): Promise<HolidayFlag> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.tenantId;
      await lockCalendar(tx, tenantId, 'update');
      const before = await this.load(tx, id);
      const after = await tx.compoundHoliday.update({
        where: { id },
        data: {
          nameEn: input.nameEn,
          nameAr: input.nameAr,
          stopsWorks: input.stopsWorks,
        },
      });
      const changes = diffChanges(
        {
          nameEn: before.nameEn,
          nameAr: before.nameAr,
          stopsWorks: before.stopsWorks,
        },
        {
          nameEn: after.nameEn,
          nameAr: after.nameAr,
          stopsWorks: after.stopsWorks,
        },
        'holiday.changed',
      );
      if (Object.keys(changes).length) {
        await this.touch(tx, tenantId);
        await this.audit.record(tx, {
          action: 'holiday.changed',
          targetId: id,
          changes,
          metadata: { day: dayOfColumn(after.day) },
        });
      }
      return flagOf(after);
    });
  }

  remove(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.tenantId;
      await lockCalendar(tx, tenantId, 'update');
      const row = await this.load(tx, id);
      await tx.compoundHoliday.delete({ where: { id } });
      await this.touch(tx, tenantId);
      await this.audit.record(tx, {
        action: 'holiday.removed',
        targetId: id,
        metadata: { day: dayOfColumn(row.day), stopsWorks: row.stopsWorks },
      });
    });
  }

  private async load(tx: TenantTxClient, id: string): Promise<CompoundHoliday> {
    const row = await tx.compoundHoliday.findUnique({ where: { id } });
    if (!row) throw notFound();
    return row;
  }

  /** The calendar changed: its row says when (the offline bundles read it). */
  private async touch(tx: TenantTxClient, tenantId: string): Promise<void> {
    await tx.holidayCalendar.update({
      where: { tenantId },
      data: { updatedAt: await dbNow(tx) },
    });
  }

  private async today(tx: TenantTxClient): Promise<LocalDate> {
    const { timezone } = await this.settings.inTx(tx, this.ctx.tenantId);
    return localDate(await dbNow(tx), timezone);
  }
}

/** The database's clock, as every domain's dbNow reads it. */
async function dbNow(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}
