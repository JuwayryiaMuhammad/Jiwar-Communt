import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StaffDashboard } from '../../core/staff-dashboard/staff-dashboard';

interface UnitCounts {
  building_id: string | null;
  units: bigint;
  occupied: bigint;
  closed: bigint;
}

/**
 * The units' section of the operations dashboard (ADR 0079), for whoever
 * reads the units' list (`units.read`, `units.directory`): how many units,
 * occupied, vacant and closed, as the register's states have it (ADR 0072:
 * closed first, then anyone living in it); per building, its units and the
 * occupied ones. And the buildings' list the status page walks. Counts and
 * the buildings' names only.
 */
@Injectable()
export class CommunityDashboardSection implements OnModuleInit {
  constructor(private readonly dashboard: StaffDashboard) {}

  onModuleInit(): void {
    this.dashboard.registerBuildings((tx) =>
      tx.building.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true },
      }),
    );
    this.dashboard.register({
      section: 'units',
      permissions: ['units.read', 'units.directory'],
      figures: async (tx) => {
        const rows = await tx.$queryRaw<UnitCounts[]>`
          SELECT NULL::uuid AS building_id, ${COUNTS}
            FROM units u`;
        const [r] = rows;
        const units = Number(r.units);
        const occupied = Number(r.occupied);
        const closed = Number(r.closed);
        return { units, occupied, vacant: units - occupied - closed, closed };
      },
      buildings: async (tx) => {
        const rows = await tx.$queryRaw<UnitCounts[]>`
          SELECT u.building_id, ${COUNTS}
            FROM units u
           WHERE u.building_id IS NOT NULL
           GROUP BY u.building_id`;
        return new Map(
          rows.map((r) => [
            r.building_id!,
            { units: Number(r.units), occupied: Number(r.occupied) },
          ]),
        );
      },
    });
  }
}

/** A unit is closed first, then occupied while anyone's occupancy is active. */
const COUNTS = Prisma.sql`count(*) AS units,
  count(*) FILTER (WHERE u.closed_since IS NULL AND EXISTS (
    SELECT 1 FROM unit_occupancies o
     WHERE o.tenant_id = u.tenant_id AND o.unit_id = u.id AND o.status = 'active')) AS occupied,
  count(*) FILTER (WHERE u.closed_since IS NOT NULL) AS closed`;
