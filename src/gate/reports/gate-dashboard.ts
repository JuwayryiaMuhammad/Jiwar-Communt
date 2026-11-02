import { Injectable, type OnModuleInit } from '@nestjs/common';
import { StaffDashboard } from '../../core/staff-dashboard/staff-dashboard';

/**
 * The gate's sections of the operations dashboard (ADR 0079): security for
 * whoever works the incidents (`incidents.manage`): the day's incidents,
 * the open and the open critical ones (ADR 0053), and the live lockdowns;
 * the gate for whoever reads it (`gate.read`): the day's entries and exits
 * and the visitors let in (as the traffic report counts them, ADR 0056).
 * Counts only: never a name, a unit or a plate.
 */
@Injectable()
export class GateDashboardSections implements OnModuleInit {
  constructor(private readonly dashboard: StaffDashboard) {}

  onModuleInit(): void {
    this.dashboard.register({
      section: 'security',
      permissions: ['incidents.manage'],
      figures: async (tx, day) => {
        const [i] = await tx.$queryRaw<
          { today: bigint; open: bigint; critical: bigint }[]
        >`
          SELECT count(*) FILTER (WHERE occurred_at >= ${day.start} AND occurred_at < ${day.end}) AS today,
                 count(*) FILTER (WHERE status IN ('open', 'investigating')) AS open,
                 count(*) FILTER (WHERE status IN ('open', 'investigating')
                                    AND severity = 'critical') AS critical
            FROM incidents`;
        const lockdowns = await tx.gateLockdown.count({
          where: { endedAt: null },
        });
        return {
          incidentsToday: Number(i.today),
          incidentsOpen: Number(i.open),
          criticalOpen: Number(i.critical),
          lockdownsLive: lockdowns,
        };
      },
    });
    this.dashboard.register({
      section: 'gate',
      permissions: ['gate.read'],
      figures: async (tx, day) => {
        const [e] = await tx.$queryRaw<
          { entries: bigint; exits: bigint; visitors: bigint }[]
        >`
          SELECT count(*) FILTER (WHERE direction = 'in') AS entries,
                 count(*) FILTER (WHERE direction = 'out') AS exits,
                 count(*) FILTER (WHERE direction = 'in' AND subject_type IN
                   ('visitor_pass', 'gate_request', 'field_exception')) AS visitors
            FROM gate_entries
           WHERE occurred_at >= ${day.start} AND occurred_at < ${day.end}`;
        return {
          entriesToday: Number(e.entries),
          exitsToday: Number(e.exits),
          visitorsToday: Number(e.visitors),
        };
      },
    });
  }
}
