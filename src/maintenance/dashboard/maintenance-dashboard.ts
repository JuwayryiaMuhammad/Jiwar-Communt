import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  StaffDashboard,
  type DashboardDay,
  type EnergyFigures,
  type MaintenanceFigures,
} from '../../core/staff-dashboard/staff-dashboard';
import { ServicePressure } from '../dispatch/service-pressure';
import { PERCENT } from '../sla/sla-at-risk';
import { SlaRecorder } from '../sla/sla-recorder';
import { SlaService } from '../sla/sla.service';
import { IN_HAND } from '../tickets/ticket-rules';

/** Work to do: new, or in a technician's hands (not completed). */
const OPEN = Prisma.sql`t.status::text IN (${Prisma.join(['new', ...IN_HAND])})`;

/**
 * A ticket's building (ADR 0072): its unit's, or, for a common area's
 * ticket, the building the area names (as the list's `buildingId`, ADR
 * 0076). `t` the ticket; adds `b` the building.
 */
const BUILDING_JOIN = Prisma.sql`
  LEFT JOIN units u ON u.id = t.unit_id
  LEFT JOIN common_areas ca ON ca.id = t.common_area_id
  JOIN buildings b ON b.tenant_id = t.tenant_id
   AND (b.id = u.building_id OR (t.unit_id IS NULL AND b.name = ca.building))`;

interface TicketCounts {
  open: bigint;
  unassigned: bigint;
  on_hold: bigint;
  awaiting: bigint;
  emergency_open: bigint;
  emergency_unassigned: bigint;
  opened_today: bigint;
  completed_today: bigint;
  closed_today: bigint;
}

/**
 * Maintenance's sections of the operations dashboard (ADR 0079): the
 * tickets, the SLA (ADR 0034, 0076) and service pressure for the dispatch
 * (`tickets.dispatch`); the outages and the meters' spikes (ADR 0066) for
 * whoever reads energy (`energy.read`). Per building: open, overdue and
 * emergency tickets, and the outages in force. Counts only, never a
 * ticket's words, a unit or a person.
 */
@Injectable()
export class MaintenanceDashboardSections implements OnModuleInit {
  constructor(
    private readonly dashboard: StaffDashboard,
    private readonly sla: SlaService,
    private readonly recorder: SlaRecorder,
    private readonly pressure: ServicePressure,
  ) {}

  onModuleInit(): void {
    this.dashboard.register({
      section: 'maintenance',
      permissions: ['tickets.dispatch'],
      figures: (tx, day) => this.maintenance(tx, day),
      buildings: (tx, day) => this.maintenanceByBuilding(tx, day),
    });
    this.dashboard.register({
      section: 'energy',
      permissions: ['energy.read'],
      figures: (tx, day) => this.energy(tx, day),
      buildings: (tx, day) => this.outagesByBuilding(tx, day),
    });
  }

  private async maintenance(
    tx: TenantTxClient,
    day: DashboardDay,
  ): Promise<MaintenanceFigures> {
    const [c] = await tx.$queryRaw<TicketCounts[]>`
      SELECT count(*) FILTER (WHERE ${OPEN}) AS open,
             count(*) FILTER (WHERE ${OPEN} AND t.technician_account_id IS NULL) AS unassigned,
             count(*) FILTER (WHERE t.status = 'on_hold') AS on_hold,
             count(*) FILTER (WHERE t.status = 'completed') AS awaiting,
             count(*) FILTER (WHERE ${OPEN} AND t.priority = 'emergency') AS emergency_open,
             count(*) FILTER (WHERE ${OPEN} AND t.priority = 'emergency'
                                AND t.technician_account_id IS NULL) AS emergency_unassigned,
             count(*) FILTER (WHERE t.created_at >= ${day.start} AND t.created_at < ${day.end}) AS opened_today,
             count(*) FILTER (WHERE t.completed_at >= ${day.start} AND t.completed_at < ${day.end}) AS completed_today,
             count(*) FILTER (WHERE t.closed_at >= ${day.start} AND t.closed_at < ${day.end}) AS closed_today
        FROM tickets t`;
    const overdue = await this.overdue(tx, day.now);
    const atRisk = overdue.enabled ? await this.atRisk(tx, day.now) : 0;
    const [{ planned }] = await tx.$queryRaw<{ planned: bigint }[]>`
      SELECT count(*) AS planned FROM maintenance_plan_occurrences
       WHERE status = 'open' AND due_on = ${day.date}::date`;
    const [{ inspections }] = await tx.$queryRaw<{ inspections: bigint }[]>`
      SELECT count(*) AS inspections FROM inspections
       WHERE status IN ('scheduled', 'in_progress') AND due_on = ${day.date}::date`;
    const p = await this.pressure.state(tx);
    return {
      slaEnabled: overdue.enabled,
      open: Number(c.open),
      unassigned: Number(c.unassigned),
      onHold: Number(c.on_hold),
      awaitingConfirmation: Number(c.awaiting),
      emergencyOpen: Number(c.emergency_open),
      emergencyUnassigned: Number(c.emergency_unassigned),
      atRisk,
      overdue: overdue.total,
      overdueEmergency: overdue.emergency,
      openedToday: Number(c.opened_today),
      completedToday: Number(c.completed_today),
      closedToday: Number(c.closed_today),
      plannedDueToday: Number(planned),
      inspectionsDueToday: Number(inspections),
      pressure: {
        threshold: p.threshold,
        available: p.available,
        underPressure: p.underPressure,
        since: p.since,
      },
    };
  }

  /** The dispatch list's `overdue` (ADR 0034), counted; none while the SLA is off. */
  private async overdue(
    tx: TenantTxClient,
    now: Date,
  ): Promise<{ enabled: boolean; total: number; emergency: number }> {
    const flags = await this.sla.conditions(tx, { overdue: true }, now);
    if (!flags) return { enabled: false, total: 0, emergency: 0 };
    const [r] = await tx.$queryRaw<{ total: bigint; emergency: bigint }[]>`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE t.priority = 'emergency') AS emergency
        FROM tickets t
       WHERE ${Prisma.join(flags, ' AND ')}`;
    return {
      enabled: true,
      total: Number(r.total),
      emergency: Number(r.emergency),
    };
  }

  /**
   * Tickets with a running clock past its share of its target and not yet
   * due (ADR 0076): what the at-risk sweep warns of, whether told or not.
   */
  private async atRisk(tx: TenantTxClient, now: Date): Promise<number> {
    if (!(await this.recorder.activation(tx))) return 0;
    const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT c.ticket_id) AS n
        FROM ticket_sla_clocks c
        JOIN tickets t ON t.id = c.ticket_id
        JOIN maintenance_sla_settings s ON s.tenant_id = c.tenant_id
       WHERE c.state = 'running' AND c.due_at > ${now}
         AND ${OPEN}
         AND ${PERCENT} IS NOT NULL
         AND c.due_at - (c.target_minutes * (100 - ${PERCENT})) * interval '600 milliseconds' <= ${now}`;
    return Number(n);
  }

  private async maintenanceByBuilding(
    tx: TenantTxClient,
    day: DashboardDay,
  ): Promise<
    Map<string, { open: number; overdue: number; emergencyOpen: number }>
  > {
    const rows = await tx.$queryRaw<
      { building_id: string; open: bigint; emergency_open: bigint }[]
    >`
      SELECT b.id AS building_id, count(*) AS open,
             count(*) FILTER (WHERE t.priority = 'emergency') AS emergency_open
        FROM tickets t ${BUILDING_JOIN}
       WHERE ${OPEN}
       GROUP BY b.id`;
    const flags = await this.sla.conditions(tx, { overdue: true }, day.now);
    const late = flags
      ? await tx.$queryRaw<{ building_id: string; overdue: bigint }[]>`
          SELECT b.id AS building_id, count(*) AS overdue
            FROM tickets t ${BUILDING_JOIN}
           WHERE ${Prisma.join(flags, ' AND ')}
           GROUP BY b.id`
      : [];
    const out = new Map<
      string,
      { open: number; overdue: number; emergencyOpen: number }
    >();
    for (const r of rows)
      out.set(r.building_id, {
        open: Number(r.open),
        overdue: 0,
        emergencyOpen: Number(r.emergency_open),
      });
    for (const r of late) {
      const b = out.get(r.building_id) ?? {
        open: 0,
        overdue: 0,
        emergencyOpen: 0,
      };
      out.set(r.building_id, { ...b, overdue: Number(r.overdue) });
    }
    return out;
  }

  private async energy(
    tx: TenantTxClient,
    day: DashboardDay,
  ): Promise<EnergyFigures> {
    const [o] = await tx.$queryRaw<{ active: bigint; later: bigint }[]>`
      SELECT count(*) FILTER (WHERE starts_at <= ${day.now}) AS active,
             count(*) FILTER (WHERE starts_at > ${day.now} AND starts_at < ${day.end}) AS later
        FROM utility_outages
       WHERE ended_at IS NULL AND cancelled_at IS NULL AND ends_at > ${day.now}`;
    const alerts = await tx.meterAlert.count({
      where: { acknowledgedAt: null },
    });
    return {
      outagesActive: Number(o.active),
      outagesLaterToday: Number(o.later),
      meterAlertsOpen: alerts,
    };
  }

  /** An outage of the whole compound cuts every building. */
  private async outagesByBuilding(
    tx: TenantTxClient,
    day: DashboardDay,
  ): Promise<Map<string, { outagesActive: number }>> {
    const rows = await tx.$queryRaw<{ building_id: string; active: bigint }[]>`
      SELECT b.id AS building_id, count(*) AS active
        FROM buildings b
        JOIN utility_outages o ON o.tenant_id = b.tenant_id
       WHERE o.ended_at IS NULL AND o.cancelled_at IS NULL
         AND o.starts_at <= ${day.now} AND o.ends_at > ${day.now}
         AND (o.scope = 'compound' OR b.name = ANY(o.buildings))
       GROUP BY b.id`;
    return new Map(
      rows.map((r) => [r.building_id, { outagesActive: Number(r.active) }]),
    );
  }
}
