import { Injectable } from '@nestjs/common';
import { toCsv } from '../../core/common/csv';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { dateColumn, type LocalDate } from '../schedules/local-dates';
import { requirePeriod } from '../tickets/ticket-export';

export interface SlaReportRow {
  categoryKey: string;
  priority: string;
  clock: string;
  met: number;
  breached: number;
  /** met / (met + breached), three decimals. */
  metRate: number;
}

export interface SlaReport {
  from: LocalDate;
  to: LocalDate;
  totals: {
    clock: string;
    met: number;
    breached: number;
    metRate: number | null;
  }[];
  rows: SlaReportRow[];
}

const rate = (met: number, breached: number) =>
  met + breached ? Math.round((met / (met + breached)) * 1000) / 1000 : null;

/**
 * Whether the SLA was kept (ADR 0076): the clocks that ended met or
 * breached on a period of the compound's days (at most a year), by
 * category, priority and clock, with the share met; and the totals per
 * clock. A stopped clock (the SLA turned off, a new cycle) is no verdict
 * and is not counted. Keys and counts only. As JSON and CSV.
 */
@Injectable()
export class SlaReports {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly calendar: CompoundCalendar,
  ) {}

  report(from: LocalDate, to: LocalDate): Promise<SlaReport> {
    requirePeriod(from, to);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { timeZone } = await this.calendar.now(tx);
      const rows = await tx.$queryRaw<
        {
          category_key: string;
          priority: string;
          clock: string;
          met: bigint;
          breached: bigint;
        }[]
      >`
        SELECT k.key AS category_key, t.priority::text AS priority, c.clock::text AS clock,
               count(*) FILTER (WHERE c.state = 'met') AS met,
               count(*) FILTER (WHERE c.state = 'breached') AS breached
          FROM ticket_sla_clocks c
          JOIN tickets t ON t.id = c.ticket_id
          JOIN ticket_categories k ON k.id = t.category_id
         WHERE c.state IN ('met', 'breached')
           AND (c.ended_at AT TIME ZONE ${timeZone})::date
               BETWEEN ${dateColumn(from)}::date AND ${dateColumn(to)}::date
         GROUP BY k.key, t.priority, c.clock
         ORDER BY k.key, t.priority, c.clock`;
      const out: SlaReportRow[] = rows.map((r) => {
        const met = Number(r.met);
        const breached = Number(r.breached);
        return {
          categoryKey: r.category_key,
          priority: r.priority,
          clock: r.clock,
          met,
          breached,
          metRate: rate(met, breached)!,
        };
      });
      const totals = (['response', 'resolution'] as const).map((clock) => {
        const of = out.filter((r) => r.clock === clock);
        const met = of.reduce((n, r) => n + r.met, 0);
        const breached = of.reduce((n, r) => n + r.breached, 0);
        return { clock, met, breached, metRate: rate(met, breached) };
      });
      return { from, to, totals, rows: out };
    });
  }

  async csv(from: LocalDate, to: LocalDate): Promise<Buffer> {
    const { rows } = await this.report(from, to);
    return toCsv(
      [
        { header: 'category_key', kind: 'text' },
        { header: 'priority', kind: 'text' },
        { header: 'clock', kind: 'text' },
        { header: 'met', kind: 'number' },
        { header: 'breached', kind: 'number' },
        { header: 'met_rate', kind: 'number' },
      ],
      rows.map((r) => [
        r.categoryKey,
        r.priority,
        r.clock,
        String(r.met),
        String(r.breached),
        String(r.metRate),
      ]),
    );
  }
}
