import { ApiProperty } from '@nestjs/swagger';
import { REASON_CODES } from '../../../core/common/reasons';

/** Incidents counted over the period (ADR 0053). */
export class IncidentReportCountsView {
  @ApiProperty({ type: Number })
  reported: number;
  @ApiProperty({
    type: Number,
    description: 'Reported by a guard on shift; the rest by the management.',
  })
  byGuards: number;
  @ApiProperty({ type: Number })
  low: number;
  @ApiProperty({ type: Number })
  medium: number;
  @ApiProperty({ type: Number })
  high: number;
  @ApiProperty({ type: Number })
  critical: number;
  @ApiProperty({ type: Number, description: 'Open now.' })
  open: number;
  @ApiProperty({ type: Number, description: 'Under investigation now.' })
  investigating: number;
  @ApiProperty({ type: Number })
  closed: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'From the report to its close, on average, in hours (one decimal).',
  })
  avgHoursToClose: number | null;
}

export class IncidentReportTypeView extends IncidentReportCountsView {
  @ApiProperty({ enum: REASON_CODES.incidentType, enumName: 'IncidentType' })
  type: string;
}

export class IncidentReportView {
  @ApiProperty({ type: String, format: 'date', example: '2026-11-01' })
  from: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-11-07' })
  to: string;
  @ApiProperty({ type: IncidentReportCountsView })
  totals: IncidentReportCountsView;
  @ApiProperty({
    type: [IncidentReportTypeView],
    description: 'Every type, in a fixed order, zeros included.',
  })
  types: IncidentReportTypeView[];
}

/** Violations counted over the period (ADR 0053). */
export class ViolationReportCountsView {
  @ApiProperty({ type: Number })
  issued: number;
  @ApiProperty({
    type: Number,
    description: 'Issued by a guard on shift; the rest by the office.',
  })
  byGuards: number;
  @ApiProperty({ type: Number, description: 'Without an amount.' })
  warnings: number;
  @ApiProperty({ type: Number, description: 'With an amount.' })
  fined: number;
  @ApiProperty({
    type: String,
    example: '1250.00',
    description: 'The amounts issued, cancelled ones included.',
  })
  amountIssued: string;
  @ApiProperty({ type: Number, description: 'Open now.' })
  open: number;
  @ApiProperty({ type: Number, description: 'Under appeal now.' })
  underAppeal: number;
  @ApiProperty({ type: Number })
  paid: number;
  @ApiProperty({ type: Number })
  cancelled: number;
  @ApiProperty({ type: String, example: '500.00' })
  amountPaid: string;
  @ApiProperty({ type: Number })
  appealed: number;
  @ApiProperty({ type: Number })
  appealsUpheld: number;
  @ApiProperty({ type: Number, description: 'Cancelled on appeal.' })
  appealsAccepted: number;
}

export class ViolationReportKindView extends ViolationReportCountsView {
  @ApiProperty({ enum: REASON_CODES.violationKind, enumName: 'ViolationKind' })
  kind: string;
}

export class ViolationReportView {
  @ApiProperty({ type: String, format: 'date', example: '2026-11-01' })
  from: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-11-07' })
  to: string;
  @ApiProperty({ type: String, enum: ['EGP'] })
  currency: string;
  @ApiProperty({ type: ViolationReportCountsView })
  totals: ViolationReportCountsView;
  @ApiProperty({
    type: [ViolationReportKindView],
    description: 'Every kind, in a fixed order, zeros included.',
  })
  kinds: ViolationReportKindView[];
}
