import { Injectable } from '@nestjs/common';
import type { Permission } from '../access/permissions';
import {
  addDays,
  localParts,
  zonedInstant,
  type LocalDate,
} from '../common/slots/day-slots';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// The operations dashboard (ADR 0079)
// ============================================================================
//
// The manager's cards, "needs you now", the buildings' status and the daily
// brief and end-of-day review, across the domains. Core imports no domain
// (ADR 0015): each domain registers its section here at startup, as with
// the inbox (ADR 0073), and reads its figures in the caller's tenant
// transaction (RLS) in a fixed number of aggregate queries. A section shows
// to the holders of its own domain's permission only. Figures are counts,
// shares and amounts of the compound: never a person, a unit or a word.

/** The sections, in the order the dashboard shows them. */
export const DASHBOARD_SECTIONS = [
  'units',
  'maintenance',
  'energy',
  'security',
  'gate',
  'finance',
] as const;
export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number];

/**
 * The compound's local day the figures are of (its time zone), and the
 * instant they are read at.
 */
export interface DashboardDay {
  date: LocalDate;
  /** The local midnight that starts the day, and the next one. */
  start: Date;
  end: Date;
  /** The first day of the day's month, and its local midnight. */
  monthDate: LocalDate;
  monthStart: Date;
  now: Date;
  timeZone: string;
}

export interface UnitsFigures {
  units: number;
  /** With an active occupancy. */
  occupied: number;
  vacant: number;
  /** In closed-unit mode (ADR 0020). */
  closed: number;
}

export interface PressureFigures {
  /** Open tickets one available technician may carry; null: no alert. */
  threshold: number | null;
  /** Technicians who take work now (ADR 0033). */
  available: number;
  underPressure: boolean;
  /** When the current rise began, or null. */
  since: Date | string | null;
}

export interface MaintenanceFigures {
  /** Whether the SLA runs (ADR 0034): `overdue` and `atRisk` are 0 while not. */
  slaEnabled: boolean;
  /** Work to do: new, or in a technician's hands (not completed). */
  open: number;
  unassigned: number;
  onHold: number;
  /** Completed, waiting for the residents' confirmation. */
  awaitingConfirmation: number;
  emergencyOpen: number;
  emergencyUnassigned: number;
  /** A running clock past its share of its target, not yet late (ADR 0076). */
  atRisk: number;
  /** The dispatch list's `overdue` (ADR 0034). */
  overdue: number;
  overdueEmergency: number;
  openedToday: number;
  completedToday: number;
  closedToday: number;
  /** Plan occurrences and inspections due today (ADR 0064). */
  plannedDueToday: number;
  inspectionsDueToday: number;
  pressure: PressureFigures;
}

export interface EnergyFigures {
  /** Outages in force now (ADR 0066). */
  outagesActive: number;
  /** Outages that start later today. */
  outagesLaterToday: number;
  /** Meter spikes nobody acknowledged (ADR 0066). */
  meterAlertsOpen: number;
}

export interface SecurityFigures {
  incidentsToday: number;
  /** Open or under investigation (ADR 0053). */
  incidentsOpen: number;
  criticalOpen: number;
  /** Live lockdowns, a gate's or the compound's. */
  lockdownsLive: number;
}

export interface GateFigures {
  entriesToday: number;
  exitsToday: number;
  /** Visitors let in today: by pass, gate request or field exception. */
  visitorsToday: number;
}

export interface FinanceFigures {
  currency: string;
  /** Net of reversals, the day's and the month's so far (ADR 0048). */
  collectedToday: string;
  collectedMonth: string;
  /** What the invoices due this month so far ask, after credit notes. */
  dueMonth: string;
  /** The share of `dueMonth` paid, 0–1; null when nothing is due. */
  collectionRate: number | null;
  /** Invoices past their due day with something owed, and how much. */
  overdueInvoices: number;
  overdueAmount: string;
}

/** Every section's figures; a section the caller may not read is null. */
export interface DashboardFigures {
  units: UnitsFigures | null;
  maintenance: MaintenanceFigures | null;
  energy: EnergyFigures | null;
  security: SecurityFigures | null;
  gate: GateFigures | null;
  finance: FinanceFigures | null;
}

/** A building's figures, per section that has any (null otherwise). */
export interface BuildingFigures {
  units: { units: number; occupied: number } | null;
  maintenance: { open: number; overdue: number; emergencyOpen: number } | null;
  energy: { outagesActive: number } | null;
  security: null;
  gate: null;
  finance: null;
}

export interface DashboardSource<K extends DashboardSection> {
  section: K;
  /** The caller holds any of these, or the section is null. */
  permissions: readonly Permission[];
  /** The section's figures as of `day.now`, in a fixed number of queries. */
  figures(
    tx: TenantTxClient,
    day: DashboardDay,
  ): Promise<NonNullable<DashboardFigures[K]>>;
  /** Per building id (ADR 0072), for the buildings' status. */
  buildings?(
    tx: TenantTxClient,
    day: DashboardDay,
  ): Promise<Map<string, NonNullable<BuildingFigures[K]>>>;
}

/** A building of the compound's register (ADR 0072): its id and name. */
export interface DirectoryBuilding {
  id: string;
  name: string;
}

export type BuildingDirectory = (
  tx: TenantTxClient,
) => Promise<DirectoryBuilding[]>;

/** Something that needs the manager now, from the figures. */
export interface DashboardAlert {
  section: DashboardSection;
  code: string;
  severity: 'critical' | 'warning';
  count: number;
}

export type BuildingBand = 'ok' | 'attention' | 'critical';

/**
 * The compound's liquidity (ADR 0091), finance's, registered as a section
 * is: the days of spending the cash covers, and the alert when the cash, or
 * the cash flow forecast, falls below the compound's minimum. To the
 * holders of its permissions only; null to the others.
 */
export interface LiquiditySource {
  /** The caller holds any of these, or the liquidity is null. */
  permissions: readonly Permission[];
  /** Days of spending the cash covers; null when it cannot be computed. */
  days(tx: TenantTxClient, day: DashboardDay): Promise<number | null>;
  /** `cash_below_minimum` (critical) or `cash_forecast_below_minimum` (warning), or null. */
  alert(tx: TenantTxClient, day: DashboardDay): Promise<DashboardAlert | null>;
}

export const emptyFigures = (): DashboardFigures => ({
  units: null,
  maintenance: null,
  energy: null,
  security: null,
  gate: null,
  finance: null,
});

/**
 * What needs the manager now (ADR 0079), from the figures the caller may
 * read: the critical first. Rules, not a model: an emergency overdue or
 * unassigned, a live lockdown or an open critical incident is critical;
 * other overdue tickets, service pressure, an outage in force and an
 * unacknowledged meter spike are warnings.
 */
export function alertsOf(f: DashboardFigures): DashboardAlert[] {
  const out: DashboardAlert[] = [];
  const add = (
    section: DashboardSection,
    code: string,
    severity: DashboardAlert['severity'],
    count: number,
  ) => {
    if (count > 0) out.push({ section, code, severity, count });
  };
  const m = f.maintenance;
  if (m) {
    add('maintenance', 'emergency_overdue', 'critical', m.overdueEmergency);
    add(
      'maintenance',
      'emergency_unassigned',
      'critical',
      m.emergencyUnassigned,
    );
  }
  if (f.security) {
    add('security', 'lockdown_live', 'critical', f.security.lockdownsLive);
    add(
      'security',
      'incident_critical_open',
      'critical',
      f.security.criticalOpen,
    );
  }
  if (m) {
    add(
      'maintenance',
      'tickets_overdue',
      'warning',
      m.overdue - m.overdueEmergency,
    );
    if (m.pressure.underPressure)
      add('maintenance', 'service_pressure', 'warning', m.open);
  }
  if (f.energy) {
    add('energy', 'outage_active', 'warning', f.energy.outagesActive);
    add('energy', 'meter_alert_open', 'warning', f.energy.meterAlertsOpen);
  }
  return out;
}

/**
 * A building's band (ADR 0079), from the sections the caller may read:
 * critical with an outage in force or an emergency open in it; attention
 * with an overdue ticket; ok otherwise.
 */
export function bandOf(b: BuildingFigures): BuildingBand {
  if ((b.energy?.outagesActive ?? 0) > 0) return 'critical';
  if ((b.maintenance?.emergencyOpen ?? 0) > 0) return 'critical';
  if ((b.maintenance?.overdue ?? 0) > 0) return 'attention';
  return 'ok';
}

/**
 * The first instant of a local day: its midnight, or the first minute of
 * it that exists when a daylight-saving change skips midnight.
 */
export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  for (let minute = 0; minute <= 120; minute += 30) {
    const at = zonedInstant(date, minute, timeZone);
    if (at) return at;
  }
  throw new Error(`No start of ${date} in ${timeZone}`);
}

/** The compound's day around `now`, in its time zone. */
export function dayOf(now: Date, timeZone: string): DashboardDay {
  const { date } = localParts(now, timeZone);
  const monthDate = `${date.slice(0, 7)}-01`;
  return {
    date,
    start: startOfLocalDay(date, timeZone),
    end: startOfLocalDay(addDays(date, 1), timeZone),
    monthDate,
    monthStart: startOfLocalDay(monthDate, timeZone),
    now,
    timeZone,
  };
}

@Injectable()
export class StaffDashboard {
  private readonly sources = new Map<
    DashboardSection,
    DashboardSource<DashboardSection>
  >();
  private directory: BuildingDirectory | null = null;
  private liquiditySource: LiquiditySource | null = null;

  register<K extends DashboardSection>(source: DashboardSource<K>): void {
    if (this.sources.has(source.section))
      throw new Error(`Dashboard section ${source.section} registered twice`);
    this.sources.set(source.section, source);
  }

  /** The buildings' list (community's, ADR 0072): one reader. */
  registerBuildings(reader: BuildingDirectory): void {
    if (this.directory) throw new Error('Buildings are registered twice');
    this.directory = reader;
  }

  /** The liquidity days and the minimum-cash alert (finance's, ADR 0091): one reader. */
  registerLiquidity(source: LiquiditySource): void {
    if (this.liquiditySource) throw new Error('Liquidity is registered twice');
    this.liquiditySource = source;
  }

  liquidity(): LiquiditySource {
    if (!this.liquiditySource) throw new Error('No liquidity registered');
    return this.liquiditySource;
  }

  buildings(tx: TenantTxClient): Promise<DirectoryBuilding[]> {
    if (!this.directory) throw new Error('No building directory registered');
    return this.directory(tx);
  }

  /** In DASHBOARD_SECTIONS order. */
  all(): DashboardSource<DashboardSection>[] {
    return DASHBOARD_SECTIONS.flatMap((s) => {
      const source = this.sources.get(s);
      return source ? [source] : [];
    });
  }

  /** The sections no domain registered, and the directory (bootstrap). */
  missing(): string[] {
    return [
      ...DASHBOARD_SECTIONS.filter((s) => !this.sources.has(s)),
      ...(this.directory ? [] : ['buildings']),
      ...(this.liquiditySource ? [] : ['liquidity']),
    ];
  }
}
