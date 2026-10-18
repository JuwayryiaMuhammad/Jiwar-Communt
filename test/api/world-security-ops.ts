import { BlocklistService } from '../../src/gate/blocklist/blocklist.service';
import { IncidentsService } from '../../src/gate/incidents/incidents.service';
import { LockdownService } from '../../src/gate/lockdown/lockdown.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** B's security records (ADR 0053): foreign ids for the matrix. */
export interface SecurityOpsWorld {
  /** A lockdown of B's gate, started by B's guard and ended at once. */
  bLockdownId: string;
  /** A plate B bans. */
  bBlocklistEntryId: string;
  /** An incident B's manager reported. */
  bIncidentId: string;
}

export async function securityOpsWorld(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<SecurityOpsWorld> {
  const lockdowns = h.moduleRef.get(LockdownService);
  const { record } = await helpers.as(
    b,
    { id: b.ids.guard, type: 'staff' },
    () =>
      lockdowns.start({
        scope: 'gate',
        gateId: b.gateId,
        reasonCode: 'drill',
      }),
  );
  // Ended at once: B's gate stays open for every other suite.
  await helpers.asManager(b, () =>
    lockdowns.end(record.lockdown.id, { reasonCode: 'drill_over' }),
  );
  const entry = await helpers.asManager(b, () =>
    h.moduleRef.get(BlocklistService).create({
      kind: 'ban',
      subject: 'plate',
      plate: 'WRLD 77',
      reasonCode: 'other',
    }),
  );
  const incident = await helpers.asManager(b, async () =>
    h.moduleRef.get(IncidentsService).report(
      {
        type: 'other',
        severity: 'low',
        unitCode: (
          await helpers.prisma.tenant.unit.findUniqueOrThrow({
            where: { id: b.homeUnitId },
          })
        ).code,
        occurredAt: new Date(),
        description: 'World incident',
      },
      'staff',
    ),
  );
  return {
    bLockdownId: record.lockdown.id,
    bBlocklistEntryId: entry.entry.id,
    bIncidentId: incident.incident.id,
  };
}
