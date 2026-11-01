import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { exportTooLarge, toCsv } from '../../core/common/csv';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  dateColumn,
  daysBetween,
  isRealDate,
  type LocalDate,
} from '../schedules/local-dates';
import { SlaService } from '../sla/sla.service';
import { dispatchSql, type DispatchQuery } from './tickets.service';
import { ticketNumber } from './ticket-rules';

/** At most a year of creation days in one export. */
export const TICKET_EXPORT_DAYS = 366;
/** At most this many tickets in one export: EXPORT_TOO_LARGE beyond. */
export const TICKET_EXPORT_MAX_ROWS = 50_000;

interface ExportRow {
  number: number;
  status: string;
  priority: string;
  origin: string;
  kind: string;
  category_key: string;
  unit_code: string | null;
  building: string | null;
  area_code: string | null;
  asset_code: string | null;
  technician_id: string | null;
  confirmation_status: string | null;
  cycle: number;
  created_at: Date;
  assigned_at: Date | null;
  completed_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
}

const COLUMNS = [
  { header: 'number', kind: 'text' },
  { header: 'status', kind: 'text' },
  { header: 'priority', kind: 'text' },
  { header: 'origin', kind: 'text' },
  { header: 'kind', kind: 'text' },
  { header: 'category_key', kind: 'text' },
  { header: 'unit_code', kind: 'text' },
  { header: 'building', kind: 'text' },
  { header: 'area_code', kind: 'text' },
  { header: 'asset_code', kind: 'text' },
  { header: 'technician_id', kind: 'text' },
  { header: 'confirmation_status', kind: 'text' },
  { header: 'cycle', kind: 'number' },
  { header: 'created_at', kind: 'text' },
  { header: 'assigned_at', kind: 'text' },
  { header: 'completed_at', kind: 'text' },
  { header: 'closed_at', kind: 'text' },
  { header: 'cancelled_at', kind: 'text' },
] as const;

/**
 * The dispatch list as CSV (ADR 0076): the same filters as the list, over
 * the tickets created on a period of the compound's days (at most a year),
 * oldest first, at most `TICKET_EXPORT_MAX_ROWS` (EXPORT_TOO_LARGE beyond).
 * Codes, numbers and times only: never a ticket's words, a common area's
 * free label (an area is its code), or anyone's name.
 */
@Injectable()
export class TicketExport {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly calendar: CompoundCalendar,
    private readonly sla: SlaService,
  ) {}

  csv(q: DispatchQuery & { from: LocalDate; to: LocalDate }): Promise<Buffer> {
    requirePeriod(q.from, q.to);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { now, timeZone } = await this.calendar.now(tx);
      const flags =
        q.overdue || q.escalated ? await this.sla.conditions(tx, q, now) : [];
      if (!flags) return toCsv(COLUMNS, []);
      const where = [
        ...flags,
        ...dispatchSql(q),
        Prisma.sql`(t.created_at AT TIME ZONE ${timeZone})::date
                     BETWEEN ${dateColumn(q.from)}::date AND ${dateColumn(q.to)}::date`,
      ];
      const max = TICKET_EXPORT_MAX_ROWS;
      const rows = await tx.$queryRaw<ExportRow[]>`
        SELECT t.number, t.status::text AS status, t.priority::text AS priority,
               t.origin, t.kind::text AS kind, c.key AS category_key,
               u.code AS unit_code, COALESCE(u.building, ca.building) AS building,
               ca.code AS area_code, a.code AS asset_code,
               t.technician_account_id AS technician_id,
               t.confirmation_status::text AS confirmation_status, t.cycle,
               t.created_at, t.assigned_at, t.completed_at, t.closed_at, t.cancelled_at
          FROM tickets t
          JOIN ticket_categories c ON c.id = t.category_id
          LEFT JOIN units u ON u.id = t.unit_id
          LEFT JOIN common_areas ca ON ca.id = t.common_area_id
          LEFT JOIN assets a ON a.id = t.asset_id
         WHERE ${Prisma.join(where, ' AND ')}
         ORDER BY t.created_at, t.id
         LIMIT ${max + 1}`;
      if (rows.length > max) throw exportTooLarge(max);
      const at = (d: Date | null) => (d ? d.toISOString() : null);
      return toCsv(
        COLUMNS,
        rows.map((r) => [
          ticketNumber(r.number),
          r.status,
          r.priority,
          r.origin,
          r.kind,
          r.category_key,
          r.unit_code,
          r.building,
          r.area_code,
          r.asset_code,
          r.technician_id,
          r.confirmation_status,
          String(r.cycle),
          at(r.created_at),
          at(r.assigned_at),
          at(r.completed_at),
          at(r.closed_at),
          at(r.cancelled_at),
        ]),
      );
    });
  }
}

function requirePeriod(from: LocalDate, to: LocalDate): void {
  const field = !isRealDate(from) ? 'from' : !isRealDate(to) ? 'to' : null;
  if (field)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid period', {
      fields: [{ field, code: FieldErrorCode.INVALID_FORMAT }],
    });
  const days = daysBetween(from, to);
  if (days < 0 || days > TICKET_EXPORT_DAYS)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid period', {
      fields: [
        {
          field: 'to',
          code: FieldErrorCode.INVALID_VALUE,
          params: { maxDays: TICKET_EXPORT_DAYS },
        },
      ],
    });
}
