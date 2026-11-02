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

/** Safety incidents of the period (ADR 0087), by when they happened. */
export class SafetyIncidentsView {
  @ApiProperty({
    type: Number,
    description: 'Injuries, near misses, hazards, fires and property damage.',
  })
  reported: number;
  @ApiProperty({ type: Number })
  injuries: number;
  @ApiProperty({ type: Number })
  nearMisses: number;
  @ApiProperty({ type: Number })
  hazards: number;
  @ApiProperty({ type: Number })
  fires: number;
  @ApiProperty({ type: Number })
  propertyDamage: number;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'The compound’s day of the last injury by the period’s end.',
  })
  lastInjuryOn: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Days from the last injury to the period’s last day.',
  })
  daysWithoutInjury: number | null;
}

/** Safety observations (ADR 0087): hazards and near misses reported. */
export class SafetyObservationsView {
  @ApiProperty({ type: Number })
  reported: number;
  @ApiProperty({ type: Number, description: 'Of them, closed now.' })
  closed: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Closed over reported, in whole percent; null with none.',
  })
  closureRatePct: number | null;
  @ApiProperty({ type: Number, nullable: true })
  avgHoursToClose: number | null;
}

/** Corrective actions (ADR 0087): made in the period, and where all stand now. */
export class SafetyActionsView {
  @ApiProperty({ type: Number, description: 'Made in the period.' })
  opened: number;
  @ApiProperty({ type: Number, description: 'Of them, done.' })
  done: number;
  @ApiProperty({ type: Number, description: 'Of them, done by their day.' })
  doneOnTime: number;
  @ApiProperty({ type: Number })
  cancelled: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Done by their day over done, in whole percent.',
  })
  onTimeRatePct: number | null;
  @ApiProperty({ type: Number, description: 'Every action open now.' })
  openNow: number;
  @ApiProperty({ type: Number, description: 'Open now and past their day.' })
  overdueNow: number;
}

/** Drills (ADR 0087): the readiness items of kind `drill`. */
export class SafetyDrillsView {
  @ApiProperty({ type: Number, description: 'Due on the period’s days.' })
  scheduled: number;
  @ApiProperty({ type: Number, description: 'Done in the period.' })
  held: number;
  @ApiProperty({ type: Number })
  passed: number;
  @ApiProperty({ type: Number })
  issuesFound: number;
  @ApiProperty({ type: Number })
  failed: number;
  @ApiProperty({ type: Number, description: 'Who took part, in all.' })
  participants: number;
  @ApiProperty({ type: Number, nullable: true })
  avgMinutes: number | null;
}

/** The safety KPIs (ADR 0087): counts and rates only, over up to 366 days. */
export class SafetyReportView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: SafetyIncidentsView })
  incidents: SafetyIncidentsView;
  @ApiProperty({ type: SafetyObservationsView })
  observations: SafetyObservationsView;
  @ApiProperty({ type: SafetyActionsView })
  actions: SafetyActionsView;
  @ApiProperty({ type: SafetyDrillsView })
  drills: SafetyDrillsView;
}
