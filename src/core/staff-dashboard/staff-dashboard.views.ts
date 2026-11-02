import { ApiProperty } from '@nestjs/swagger';
import type { StaffBrief } from '@prisma/client';
import {
  InboxCountView,
  InboxItemView,
} from '../staff-inbox/staff-inbox.views';
import {
  BRIEF_KINDS,
  type BriefKind,
  type BriefRead,
} from './staff-briefs.service';
import {
  DASHBOARD_SECTIONS,
  type BuildingBand,
  type DashboardAlert,
  type DashboardFigures,
  type DashboardSection,
} from './staff-dashboard';
import type {
  BuildingsStatus,
  DashboardSettings,
  DashboardSummary,
  NeedsYou,
} from './staff-dashboard.service';

export class UnitsFiguresView {
  @ApiProperty({ type: Number })
  units: number;
  @ApiProperty({ type: Number, description: 'With an active occupancy.' })
  occupied: number;
  @ApiProperty({ type: Number })
  vacant: number;
  @ApiProperty({ type: Number, description: 'In closed-unit mode.' })
  closed: number;
}

export class PressureFiguresView {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Open tickets one available technician may carry; null: no alert.',
  })
  threshold: number | null;
  @ApiProperty({ type: Number })
  available: number;
  @ApiProperty({ type: Boolean })
  underPressure: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  since: string | null;
}

export class MaintenanceFiguresView {
  @ApiProperty({
    type: Boolean,
    description:
      'Whether the SLA runs: `overdue` and `atRisk` are 0 while not.',
  })
  slaEnabled: boolean;
  @ApiProperty({
    type: Number,
    description: 'New, or in a technician’s hands.',
  })
  open: number;
  @ApiProperty({ type: Number })
  unassigned: number;
  @ApiProperty({ type: Number })
  onHold: number;
  @ApiProperty({
    type: Number,
    description: 'Completed, waiting for the residents’ confirmation.',
  })
  awaitingConfirmation: number;
  @ApiProperty({ type: Number })
  emergencyOpen: number;
  @ApiProperty({ type: Number })
  emergencyUnassigned: number;
  @ApiProperty({
    type: Number,
    description: 'A running clock past its share of its target, not yet late.',
  })
  atRisk: number;
  @ApiProperty({ type: Number, description: 'As the list’s `overdue`.' })
  overdue: number;
  @ApiProperty({ type: Number })
  overdueEmergency: number;
  @ApiProperty({ type: Number })
  openedToday: number;
  @ApiProperty({ type: Number })
  completedToday: number;
  @ApiProperty({ type: Number })
  closedToday: number;
  @ApiProperty({ type: Number, description: 'Plan occurrences due today.' })
  plannedDueToday: number;
  @ApiProperty({ type: Number })
  inspectionsDueToday: number;
  @ApiProperty({ type: () => PressureFiguresView })
  pressure: PressureFiguresView;
}

export class EnergyFiguresView {
  @ApiProperty({ type: Number, description: 'Outages in force now.' })
  outagesActive: number;
  @ApiProperty({ type: Number, description: 'Outages that start later today.' })
  outagesLaterToday: number;
  @ApiProperty({
    type: Number,
    description: 'Meter spikes nobody acknowledged.',
  })
  meterAlertsOpen: number;
}

export class SecurityFiguresView {
  @ApiProperty({ type: Number })
  incidentsToday: number;
  @ApiProperty({ type: Number, description: 'Open or under investigation.' })
  incidentsOpen: number;
  @ApiProperty({ type: Number })
  criticalOpen: number;
  @ApiProperty({ type: Number })
  lockdownsLive: number;
}

export class GateFiguresView {
  @ApiProperty({ type: Number })
  entriesToday: number;
  @ApiProperty({ type: Number })
  exitsToday: number;
  @ApiProperty({
    type: Number,
    description:
      'Visitors let in today: by pass, gate request or field exception.',
  })
  visitorsToday: number;
}

export class FinanceFiguresView {
  @ApiProperty({ type: String, example: 'EGP' })
  currency: string;
  @ApiProperty({ type: String, description: 'Net of reversals.' })
  collectedToday: string;
  @ApiProperty({
    type: String,
    description: 'Net of reversals, the month so far.',
  })
  collectedMonth: string;
  @ApiProperty({
    type: String,
    description:
      'What the invoices due this month so far ask, after credit notes.',
  })
  dueMonth: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The share of `dueMonth` paid, 0–1; null when nothing is due.',
  })
  collectionRate: number | null;
  @ApiProperty({ type: Number })
  overdueInvoices: number;
  @ApiProperty({ type: String })
  overdueAmount: string;
}

/** Every section; one the caller may not read is null. */
export class DashboardFiguresView {
  @ApiProperty({ type: () => UnitsFiguresView, nullable: true })
  units: UnitsFiguresView | null;
  @ApiProperty({ type: () => MaintenanceFiguresView, nullable: true })
  maintenance: MaintenanceFiguresView | null;
  @ApiProperty({ type: () => EnergyFiguresView, nullable: true })
  energy: EnergyFiguresView | null;
  @ApiProperty({ type: () => SecurityFiguresView, nullable: true })
  security: SecurityFiguresView | null;
  @ApiProperty({ type: () => GateFiguresView, nullable: true })
  gate: GateFiguresView | null;
  @ApiProperty({ type: () => FinanceFiguresView, nullable: true })
  finance: FinanceFiguresView | null;

  static from(f: DashboardFigures): DashboardFiguresView {
    const m = f.maintenance;
    return Object.assign(new DashboardFiguresView(), {
      units: f.units ? { ...f.units } : null,
      maintenance: m
        ? {
            ...m,
            pressure: {
              ...m.pressure,
              since:
                m.pressure.since instanceof Date
                  ? m.pressure.since.toISOString()
                  : m.pressure.since,
            },
          }
        : null,
      energy: f.energy ? { ...f.energy } : null,
      security: f.security ? { ...f.security } : null,
      gate: f.gate ? { ...f.gate } : null,
      finance: f.finance ? { ...f.finance } : null,
    });
  }
}

export class InboxBadgeView {
  @ApiProperty({ type: Number })
  total: number;
  @ApiProperty({ type: Number })
  overdue: number;
}

/** The summary cards (ADR 0079): one call, counts and amounts only. */
export class DashboardSummaryView {
  @ApiProperty({ type: String, format: 'date-time' })
  asOf: Date;
  @ApiProperty({
    type: String,
    example: '2026-11-02',
    description: 'The compound’s day.',
  })
  date: string;
  @ApiProperty({ type: String, example: 'Africa/Cairo' })
  timeZone: string;
  @ApiProperty({ type: () => DashboardFiguresView })
  figures: DashboardFiguresView;
  @ApiProperty({
    type: () => InboxBadgeView,
    nullable: true,
    description:
      'What waits for the caller’s decision; null without `inbox.read`.',
  })
  inbox: InboxBadgeView | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Days of spending the cash covers: always null until cash flow is built.',
  })
  liquidityDays: null;

  static from(s: DashboardSummary): DashboardSummaryView {
    return Object.assign(new DashboardSummaryView(), {
      asOf: s.asOf,
      date: s.date,
      timeZone: s.timeZone,
      figures: DashboardFiguresView.from(s.figures),
      inbox: s.inbox ? { ...s.inbox } : null,
      liquidityDays: null,
    });
  }
}

export class DashboardAlertView {
  @ApiProperty({ enum: DASHBOARD_SECTIONS, enumName: 'DashboardSection' })
  section: DashboardSection;
  @ApiProperty({
    type: String,
    description:
      'emergency_overdue, emergency_unassigned, lockdown_live, incident_critical_open (critical); tickets_overdue, service_pressure, outage_active, meter_alert_open (warning).',
  })
  code: string;
  @ApiProperty({ enum: ['critical', 'warning'] })
  severity: 'critical' | 'warning';
  @ApiProperty({ type: Number })
  count: number;
}

/** What needs the caller now: alerts, then the inbox's items. */
export class NeedsYouView {
  @ApiProperty({ type: String, format: 'date-time' })
  asOf: Date;
  @ApiProperty({
    type: [DashboardAlertView],
    description: 'The critical first.',
  })
  alerts: DashboardAlertView[];
  @ApiProperty({
    type: [InboxItemView],
    nullable: true,
    description:
      'The inbox’s overdue items first, then its oldest (10 at most); null without `inbox.read`.',
  })
  items: InboxItemView[] | null;
  @ApiProperty({ type: () => InboxCountView, nullable: true })
  inbox: InboxCountView | null;

  static from(n: NeedsYou): NeedsYouView {
    return Object.assign(new NeedsYouView(), {
      asOf: n.asOf,
      alerts: n.alerts.map((a: DashboardAlert) => ({ ...a })),
      items: n.items ? n.items.map((e) => InboxItemView.from(e)) : null,
      inbox: n.inbox ? InboxCountView.from(n.inbox) : null,
    });
  }
}

export class BuildingUnitsView {
  @ApiProperty({ type: Number })
  units: number;
  @ApiProperty({ type: Number })
  occupied: number;
}

export class BuildingMaintenanceView {
  @ApiProperty({ type: Number })
  open: number;
  @ApiProperty({ type: Number })
  overdue: number;
  @ApiProperty({ type: Number })
  emergencyOpen: number;
}

export class BuildingEnergyView {
  @ApiProperty({ type: Number })
  outagesActive: number;
}

export class BuildingStatusView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({
    enum: ['ok', 'attention', 'critical'],
    description:
      'critical: an outage in force or an emergency open; attention: an overdue ticket; from the sections the caller reads.',
  })
  band: BuildingBand;
  @ApiProperty({ type: () => BuildingUnitsView, nullable: true })
  units: BuildingUnitsView | null;
  @ApiProperty({ type: () => BuildingMaintenanceView, nullable: true })
  maintenance: BuildingMaintenanceView | null;
  @ApiProperty({ type: () => BuildingEnergyView, nullable: true })
  energy: BuildingEnergyView | null;
}

export class BuildingsStatusView {
  @ApiProperty({ type: String, format: 'date-time' })
  asOf: Date;
  @ApiProperty({ type: [BuildingStatusView], description: 'By name.' })
  buildings: BuildingStatusView[];

  static from(s: BuildingsStatus): BuildingsStatusView {
    return Object.assign(new BuildingsStatusView(), {
      asOf: s.asOf,
      buildings: s.buildings.map((b) => ({
        id: b.id,
        name: b.name,
        band: b.band,
        units: b.figures.units ? { ...b.figures.units } : null,
        maintenance: b.figures.maintenance
          ? { ...b.figures.maintenance }
          : null,
        energy: b.figures.energy ? { ...b.figures.energy } : null,
      })),
    });
  }
}

export class DashboardSettingsView {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '07:00',
    description:
      'When the daily brief is written, the compound’s time; null: not written.',
  })
  briefAt: string | null;
  @ApiProperty({ type: String, nullable: true, example: '17:00' })
  reviewAt: string | null;
  @ApiProperty({ type: String, example: 'Africa/Cairo' })
  timeZone: string;

  static from(s: DashboardSettings): DashboardSettingsView {
    return Object.assign(new DashboardSettingsView(), { ...s });
  }
}

export class BriefListItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: BRIEF_KINDS, enumName: 'BriefKind' })
  kind: BriefKind;
  @ApiProperty({
    type: String,
    example: '2026-11-02',
    description: 'The compound’s day.',
  })
  date: string;
  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt: Date;

  static from(b: StaffBrief): BriefListItemView {
    return Object.assign(new BriefListItemView(), {
      id: b.id,
      kind: b.kind as BriefKind,
      date: b.day.toISOString().slice(0, 10),
      generatedAt: b.generatedAt,
    });
  }
}

/** A brief as written, with the sections and inbox types the reader may read. */
export class BriefView extends BriefListItemView {
  @ApiProperty({ type: String, example: 'Africa/Cairo' })
  timeZone: string;
  @ApiProperty({ type: () => DashboardFiguresView })
  figures: DashboardFiguresView;
  @ApiProperty({
    type: () => InboxCountView,
    nullable: true,
    description: 'The types the reader decides; null without `inbox.read`.',
  })
  inbox: InboxCountView | null;

  static fromRead(b: BriefRead): BriefView {
    return Object.assign(new BriefView(), {
      id: b.id,
      kind: b.kind,
      date: b.date,
      generatedAt: b.generatedAt,
      timeZone: b.timeZone,
      figures: DashboardFiguresView.from(b.figures),
      inbox: b.inbox ? InboxCountView.from(b.inbox) : null,
    });
  }
}
