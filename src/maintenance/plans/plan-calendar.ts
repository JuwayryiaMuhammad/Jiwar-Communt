import { Injectable } from '@nestjs/common';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  dateColumn,
  daysBetween,
  isRealDate,
  ofDateColumn,
  ofDateColumnOrNull,
  type LocalDate,
} from '../schedules/local-dates';
import { afterGeneration } from './plan-rules';
import { seriesOfPlan } from './plans.service';

/** At most a quarter of days in one read. */
export const CALENDAR_DAYS = 93;
/** At most this many dates in one read. */
export const CALENDAR_MAX = 2000;

export interface CalendarEntry {
  dueOn: LocalDate;
  planId: string;
  title: string;
  assetId: string;
  assetCode: string;
  priority: string;
  /** open, done, skipped, cancelled; `projected` for a date not generated yet. */
  status: string;
  occurrenceId: string | null;
  ticketId: string | null;
}

/**
 * The planned work due over a period, across every plan (ADR 0076): the
 * occurrences already generated (their status and work order), and the
 * dates the active calendar plans will still come due on, projected from
 * their next due date (a fixed series' every date; a floating one's next
 * only, as its following date waits for the work). A usage plan has no
 * date until its metric says so. Up to 93 days and 2000 dates, by day.
 */
@Injectable()
export class PlanCalendar {
  constructor(private readonly tenantTx: TenantTx) {}

  read(from: LocalDate, to: LocalDate): Promise<CalendarEntry[]> {
    requireWindow(from, to);
    return this.tenantTx.withTenantTx(async (tx) => {
      const occurrences = await tx.$queryRaw<
        {
          id: string;
          plan_id: string;
          due_on: Date;
          original_due_on: Date;
          status: string;
          ticket_id: string | null;
          title: string;
          priority: string;
          asset_id: string;
          asset_code: string;
        }[]
      >`
        SELECT o.id, o.plan_id, o.due_on, o.original_due_on, o.status, o.ticket_id,
               p.title, p.priority::text AS priority, a.id AS asset_id, a.code AS asset_code
          FROM maintenance_plan_occurrences o
          JOIN maintenance_plans p ON p.id = o.plan_id
          JOIN assets a ON a.id = p.asset_id
         WHERE o.due_on BETWEEN ${dateColumn(from)}::date AND ${dateColumn(to)}::date
         ORDER BY o.due_on, a.code, o.id
         LIMIT ${CALENDAR_MAX}`;
      const out: CalendarEntry[] = occurrences.map((o) => ({
        dueOn: ofDateColumn(o.due_on),
        planId: o.plan_id,
        title: o.title,
        assetId: o.asset_id,
        assetCode: o.asset_code,
        priority: o.priority,
        status: o.status,
        occurrenceId: o.id,
        ticketId: o.ticket_id,
      }));
      const generated = new Set(
        occurrences.map(
          (o) => `${o.plan_id}:${ofDateColumn(o.original_due_on)}`,
        ),
      );
      const plans = await tx.maintenancePlan.findMany({
        where: {
          active: true,
          trigger: 'calendar',
          nextDueOn: { not: null, lte: dateColumn(to) },
        },
        orderBy: { id: 'asc' },
      });
      const codes = new Map(
        (
          await tx.asset.findMany({
            where: { id: { in: [...new Set(plans.map((p) => p.assetId))] } },
            select: { id: true, code: true },
          })
        ).map((a) => [a.id, a.code]),
      );
      for (const p of plans) {
        const series = seriesOfPlan(p);
        let due: LocalDate | null = ofDateColumnOrNull(p.nextDueOn);
        while (due !== null && due <= to && out.length < CALENDAR_MAX) {
          if (due >= from && !generated.has(`${p.id}:${due}`))
            out.push({
              dueOn: due,
              planId: p.id,
              title: p.title,
              assetId: p.assetId,
              assetCode: codes.get(p.assetId)!,
              priority: p.priority,
              status: 'projected',
              occurrenceId: null,
              ticketId: null,
            });
          due = afterGeneration(series, due);
        }
      }
      return out
        .sort(
          (x, y) =>
            x.dueOn.localeCompare(y.dueOn) ||
            x.assetCode.localeCompare(y.assetCode) ||
            x.planId.localeCompare(y.planId),
        )
        .slice(0, CALENDAR_MAX);
    });
  }
}

function requireWindow(from: LocalDate, to: LocalDate): void {
  const field = !isRealDate(from) ? 'from' : !isRealDate(to) ? 'to' : null;
  if (field)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid period', {
      fields: [{ field, code: FieldErrorCode.INVALID_FORMAT }],
    });
  const days = daysBetween(from, to);
  if (days < 0 || days > CALENDAR_DAYS)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid period', {
      fields: [
        {
          field: 'to',
          code: FieldErrorCode.INVALID_VALUE,
          params: { maxDays: CALENDAR_DAYS },
        },
      ],
    });
}
