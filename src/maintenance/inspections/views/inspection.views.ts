import { ApiProperty } from '@nestjs/swagger';
import type { Inspection, InspectionRound } from '@prisma/client';
import { ChecklistRunView } from '../../checklists/views/checklist.views';
import { ofDateColumn } from '../../schedules/local-dates';
import { INSPECTION_STATUSES } from '../inspection-rules';
import type { InspectionReport } from '../inspection-reports';
import type { InspectionRead } from '../inspections.service';

/** A recurring inspection (ADR 0064). */
export class InspectionRoundView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, format: 'uuid' })
  checklistId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assetId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  commonAreaId: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  assigneeId: string;
  @ApiProperty({ type: Number })
  every: number;
  @ApiProperty({ enum: ['day', 'week', 'month', 'year'] })
  unit: string;
  @ApiProperty({ type: String, format: 'date' })
  anchorOn: string;
  @ApiProperty({ type: String, format: 'date' })
  nextDueOn: string;
  @ApiProperty({ type: Number })
  leadDays: number;
  @ApiProperty({ type: Boolean })
  active: boolean;

  static from(r: InspectionRound): InspectionRoundView {
    return {
      id: r.id,
      title: r.title,
      checklistId: r.checklistId,
      assetId: r.assetId,
      commonAreaId: r.commonAreaId,
      assigneeId: r.assigneeId,
      every: r.every,
      unit: r.unit,
      anchorOn: ofDateColumn(r.anchorOn),
      nextDueOn: ofDateColumn(r.nextDueOn),
      leadDays: r.leadDays,
      active: r.active,
    };
  }
}

/** An inspection in a list. */
export class InspectionSummaryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  roundId: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  checklistId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assetId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  commonAreaId: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  assigneeId: string;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({ enum: INSPECTION_STATUSES })
  status: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scannedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  submittedAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReason: string | null;

  static from(i: Inspection): InspectionSummaryView {
    return {
      id: i.id,
      roundId: i.roundId,
      checklistId: i.checklistId,
      assetId: i.assetId,
      commonAreaId: i.commonAreaId,
      assigneeId: i.assigneeId,
      dueOn: ofDateColumn(i.dueOn),
      status: i.status,
      startedAt: i.startedAt,
      scannedAt: i.scannedAt,
      submittedAt: i.submittedAt,
      cancelReason: i.cancelReason,
    };
  }
}

class InspectionFindingView {
  @ApiProperty({ type: String, format: 'uuid' })
  itemId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  ticketId: string;
  @ApiProperty({ type: String, description: 'The follow-up’s status now.' })
  ticketStatus: string;
}

/** An inspection with its checklist, as of its version, and its findings. */
export class InspectionView extends InspectionSummaryView {
  @ApiProperty({ type: ChecklistRunView })
  checklist: ChecklistRunView;
  @ApiProperty({ type: [InspectionFindingView] })
  findings: InspectionFindingView[];

  static fromRead(r: InspectionRead): InspectionView {
    return {
      ...InspectionSummaryView.from(r.inspection),
      checklist: ChecklistRunView.from(r.run),
      findings: r.findings.map((f) => ({
        itemId: f.itemId,
        ticketId: f.ticketId,
        ticketStatus: f.ticketStatus,
      })),
    };
  }
}

class InspectionReportTotalsView {
  @ApiProperty({ type: Number }) inspections: number;
  @ApiProperty({ type: Number }) submitted: number;
  @ApiProperty({ type: Number }) cancelled: number;
  @ApiProperty({ type: Number }) open: number;
  @ApiProperty({ type: Number, description: 'Open past their day.' })
  overdue: number;
  @ApiProperty({ type: Number, description: 'Submitted by their day.' })
  onTime: number;
  @ApiProperty({ type: Number }) failedItems: number;
  @ApiProperty({ type: Number }) findings: number;
  @ApiProperty({ type: Number }) findingsClosed: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Closed findings of all, 0–1; null with none.',
  })
  closureRate: number | null;
}

class InspectionReportRowView {
  @ApiProperty({ type: String, format: 'uuid' }) inspectionId: string;
  @ApiProperty({ type: String, format: 'date' }) dueOn: string;
  @ApiProperty({ enum: INSPECTION_STATUSES }) status: string;
  @ApiProperty({ enum: ['asset', 'area'] }) targetKind: 'asset' | 'area';
  @ApiProperty({ type: String }) targetCode: string;
  @ApiProperty({ type: String }) checklistKey: string;
  @ApiProperty({ type: String, format: 'uuid' }) assigneeId: string;
  @ApiProperty({ type: String, format: 'date', nullable: true }) submittedOn:
    string | null;
  @ApiProperty({ type: Boolean, nullable: true }) onTime: boolean | null;
  @ApiProperty({ type: Number }) failedItems: number;
  @ApiProperty({ type: Number }) findings: number;
  @ApiProperty({ type: Number }) findingsClosed: number;
}

/** The inspections of a period (ADR 0064): codes and counts only. */
export class InspectionReportView {
  @ApiProperty({ type: String, format: 'date' }) from: string;
  @ApiProperty({ type: String, format: 'date' }) to: string;
  @ApiProperty({ type: InspectionReportTotalsView })
  totals: InspectionReportTotalsView;
  @ApiProperty({ type: [InspectionReportRowView] })
  rows: InspectionReportRowView[];

  static from(r: InspectionReport): InspectionReportView {
    return r;
  }
}
