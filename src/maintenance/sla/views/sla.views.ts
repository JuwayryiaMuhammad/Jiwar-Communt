import { ApiProperty } from '@nestjs/swagger';
import { SlaClock, SlaEventKind, type TicketSlaEvent } from '@prisma/client';
import type { SlaSettingsView } from '../sla-settings.service';

/** One SLA event of a ticket: dispatch only (ADR 0034). */
export class SlaEventView {
  @ApiProperty({ enum: SlaClock, enumName: 'SlaClock' })
  clock: SlaClock;
  @ApiProperty({
    type: Number,
    description:
      'The SLA cycle: a new one at a reopen and when the SLA is turned on.',
  })
  cycle: number;
  @ApiProperty({ type: Number })
  seq: number;
  @ApiProperty({ enum: SlaEventKind, enumName: 'SlaEventKind' })
  kind: SlaEventKind;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'A breach is at exactly its due time.',
  })
  at: Date;
  @ApiProperty({ type: Number })
  targetMinutes: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From the closed list `slaEvent`.',
  })
  reasonCode: string | null;

  static from(e: TicketSlaEvent): SlaEventView {
    return {
      clock: e.clock,
      cycle: e.cycle,
      seq: e.seq,
      kind: e.kind,
      at: e.at,
      targetMinutes: e.targetMinutes,
      reasonCode: e.reasonCode,
    };
  }
}

export class SlaAtRiskView {
  @ApiProperty({ type: Number, nullable: true })
  normal: number | null;
  @ApiProperty({ type: Number, nullable: true })
  urgent: number | null;
  @ApiProperty({ type: Number, nullable: true })
  emergency: number | null;
}

export class SlaSettingsResponse {
  @ApiProperty({
    type: Boolean,
    description: 'Off until the manager turns it on.',
  })
  slaEnabled: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'The last time it was turned on: no clock starts before it (nothing is backdated).',
  })
  enabledAt: Date | null;
  @ApiProperty({
    type: () => SlaAtRiskView,
    description:
      'ADR 0076: the share (%) of a clock’s target at which it is at risk, per priority; `null` for no warning.',
  })
  atRiskPercent: SlaAtRiskView;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(s: SlaSettingsView): SlaSettingsResponse {
    return {
      slaEnabled: s.slaEnabled,
      enabledAt: s.enabledAt,
      atRiskPercent: { ...s.atRiskPercent },
      updatedAt: s.updatedAt,
    };
  }
}

/** One priority's targets on a category. */
export class SlaTargetView {
  @ApiProperty({ type: Number })
  responseMinutes: number;
  @ApiProperty({ type: Number })
  resolutionMinutes: number;
}

/** A category's targets, per priority. */
export class SlaTargetsView {
  @ApiProperty({ type: SlaTargetView })
  emergency: SlaTargetView;
  @ApiProperty({ type: SlaTargetView })
  urgent: SlaTargetView;
  @ApiProperty({ type: SlaTargetView })
  normal: SlaTargetView;
}

export class SlaReportTotalView {
  @ApiProperty({ enum: ['response', 'resolution'] })
  clock: string;
  @ApiProperty({ type: Number })
  met: number;
  @ApiProperty({ type: Number })
  breached: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'met / (met + breached), three decimals; null with neither.',
  })
  metRate: number | null;
}

export class SlaReportRowView {
  @ApiProperty({ type: String })
  categoryKey: string;
  @ApiProperty({ enum: ['normal', 'urgent', 'emergency'] })
  priority: string;
  @ApiProperty({ enum: ['response', 'resolution'] })
  clock: string;
  @ApiProperty({ type: Number })
  met: number;
  @ApiProperty({ type: Number })
  breached: number;
  @ApiProperty({ type: Number })
  metRate: number;
}

/** ADR 0076: whether the SLA was kept over a period. */
export class SlaReportView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: [SlaReportTotalView] })
  totals: SlaReportTotalView[];
  @ApiProperty({ type: [SlaReportRowView] })
  rows: SlaReportRowView[];

  static from(r: {
    from: string;
    to: string;
    totals: SlaReportTotalView[];
    rows: SlaReportRowView[];
  }): SlaReportView {
    return {
      from: r.from,
      to: r.to,
      totals: r.totals.map((t) => ({ ...t })),
      rows: r.rows.map((x) => ({ ...x })),
    };
  }
}
