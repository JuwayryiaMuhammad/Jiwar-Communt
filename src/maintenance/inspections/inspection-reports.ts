import { Injectable } from '@nestjs/common';
import { toCsv } from '../../core/common/csv';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  daysBetween,
  dateColumn,
  isRealDate,
  type LocalDate,
} from '../schedules/local-dates';
import { REPORT_DAYS } from './inspection-rules';

export interface InspectionReportRow {
  inspectionId: string;
  dueOn: LocalDate;
  status: string;
  targetKind: 'asset' | 'area';
  targetCode: string;
  checklistKey: string;
  assigneeId: string;
  submittedOn: LocalDate | null;
  onTime: boolean | null;
  failedItems: number;
  findings: number;
  findingsClosed: number;
}

export interface InspectionReport {
  from: LocalDate;
  to: LocalDate;
  totals: {
    inspections: number;
    submitted: number;
    cancelled: number;
    open: number;
    overdue: number;
    onTime: number;
    failedItems: number;
    findings: number;
    findingsClosed: number;
    /** Findings whose work order is closed, of all findings; null with none. */
    closureRate: number | null;
  };
  rows: InspectionReportRow[];
}

/**
 * The inspections of a period (ADR 0064), by due date, the compound's
 * days: how many were done, on time (submitted by their due day), what
 * failed, and how many follow-ups are closed. As JSON, and as CSV through
 * `toCsv` (every text cell defused against formulas). Codes and ids only:
 * no one's name.
 */
@Injectable()
export class InspectionReports {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly calendar: CompoundCalendar,
  ) {}

  report(from: LocalDate, to: LocalDate): Promise<InspectionReport> {
    this.requirePeriod(from, to);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today, timeZone } = await this.calendar.now(tx);
      const rows = await tx.$queryRaw<
        {
          id: string;
          due_on: Date;
          status: string;
          asset_code: string | null;
          area_code: string | null;
          checklist_key: string;
          assignee: string;
          submitted_on: Date | null;
          failed: bigint;
          findings: bigint;
          closed: bigint;
        }[]
      >`
        SELECT i.id, i.due_on, i.status, a.code AS asset_code, ca.code AS area_code,
               t.key AS checklist_key, i.assignee_account_id AS assignee,
               (i.submitted_at AT TIME ZONE ${timeZone})::date AS submitted_on,
               (SELECT count(*) FROM checklist_runs r
                  JOIN checklist_answers x ON x.run_id = r.id
                 WHERE r.inspection_id = i.id AND r.status = 'submitted' AND x.result = 'fail') AS failed,
               (SELECT count(*) FROM inspection_findings f WHERE f.inspection_id = i.id) AS findings,
               (SELECT count(*) FROM inspection_findings f JOIN tickets k ON k.id = f.ticket_id
                 WHERE f.inspection_id = i.id AND k.status = 'closed') AS closed
          FROM inspections i
          JOIN checklist_templates t ON t.id = i.checklist_id
          LEFT JOIN assets a ON a.id = i.asset_id
          LEFT JOIN common_areas ca ON ca.id = i.common_area_id
         WHERE i.due_on BETWEEN ${dateColumn(from)}::date AND ${dateColumn(to)}::date
         ORDER BY i.due_on, i.id`;
      const out: InspectionReportRow[] = rows.map((r) => {
        const dueOn = r.due_on.toISOString().slice(0, 10);
        const submittedOn = r.submitted_on
          ? r.submitted_on.toISOString().slice(0, 10)
          : null;
        return {
          inspectionId: r.id,
          dueOn,
          status: r.status,
          targetKind: r.asset_code !== null ? 'asset' : 'area',
          targetCode: (r.asset_code ?? r.area_code)!,
          checklistKey: r.checklist_key,
          assigneeId: r.assignee,
          submittedOn,
          onTime: submittedOn === null ? null : submittedOn <= dueOn,
          failedItems: Number(r.failed),
          findings: Number(r.findings),
          findingsClosed: Number(r.closed),
        };
      });
      const sum = (f: (r: InspectionReportRow) => number) =>
        out.reduce((n, r) => n + f(r), 0);
      const findings = sum((r) => r.findings);
      const closed = sum((r) => r.findingsClosed);
      const open = (r: InspectionReportRow) =>
        r.status === 'scheduled' || r.status === 'in_progress';
      return {
        from,
        to,
        totals: {
          inspections: out.length,
          submitted: sum((r) => (r.status === 'submitted' ? 1 : 0)),
          cancelled: sum((r) => (r.status === 'cancelled' ? 1 : 0)),
          open: sum((r) => (open(r) ? 1 : 0)),
          overdue: sum((r) => (open(r) && r.dueOn < today ? 1 : 0)),
          onTime: sum((r) => (r.onTime ? 1 : 0)),
          failedItems: sum((r) => r.failedItems),
          findings,
          findingsClosed: closed,
          closureRate: findings
            ? Math.round((closed / findings) * 1000) / 1000
            : null,
        },
        rows: out,
      };
    });
  }

  /** The same rows as CSV, every text cell through toCsv's guard. */
  async csv(from: LocalDate, to: LocalDate): Promise<Buffer> {
    const { rows } = await this.report(from, to);
    return toCsv(
      [
        { header: 'due_on', kind: 'text' },
        { header: 'status', kind: 'text' },
        { header: 'target_kind', kind: 'text' },
        { header: 'target_code', kind: 'text' },
        { header: 'checklist_key', kind: 'text' },
        { header: 'inspector_id', kind: 'text' },
        { header: 'submitted_on', kind: 'text' },
        { header: 'on_time', kind: 'text' },
        { header: 'failed_items', kind: 'number' },
        { header: 'findings', kind: 'number' },
        { header: 'findings_closed', kind: 'number' },
      ],
      rows.map((r) => [
        r.dueOn,
        r.status,
        r.targetKind,
        r.targetCode,
        r.checklistKey,
        r.assigneeId,
        r.submittedOn,
        r.onTime === null ? null : r.onTime ? 'yes' : 'no',
        String(r.failedItems),
        String(r.findings),
        String(r.findingsClosed),
      ]),
    );
  }

  private requirePeriod(from: LocalDate, to: LocalDate): void {
    const field = !isRealDate(from) ? 'from' : !isRealDate(to) ? 'to' : null;
    if (field)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid period', {
        fields: [{ field, code: FieldErrorCode.INVALID_FORMAT }],
      });
    const days = daysBetween(from, to);
    if (days < 0 || days > REPORT_DAYS)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid period', {
        fields: [
          {
            field: 'to',
            code: FieldErrorCode.INVALID_VALUE,
            params: { maxDays: REPORT_DAYS },
          },
        ],
      });
  }
}
