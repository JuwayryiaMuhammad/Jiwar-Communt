import { CheckpointsService } from '../../src/gate/patrols/checkpoints.service';
import { RoutesService } from '../../src/gate/patrols/routes.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** B's patrols (ADR 0052): foreign ids for the matrix. */
export interface PatrolsWorld {
  /** A checkpoint at B's gate. */
  bCheckpointId: string;
  /** A route from B's gate, walking that checkpoint, every day at 03:00. */
  bRouteId: string;
  /** One of its scheduled runs. */
  bRunId: string;
}

export async function patrolsWorld(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<PatrolsWorld> {
  return helpers.asManager(b, async () => {
    const checkpoint = await h.moduleRef.get(CheckpointsService).create({
      gateId: b.gateId,
      nameEn: 'World fence',
      nameAr: 'سور العالم',
    });
    const route = await h.moduleRef.get(RoutesService).create({
      gateId: b.gateId,
      nameEn: 'World round',
      nameAr: 'جولة العالم',
      version: {
        checkpointIds: [checkpoint.id],
        ordered: false,
        expectedMinutes: 20,
        schedule: { days: [0, 1, 2, 3, 4, 5, 6], times: ['03:00'] },
      },
    });
    const run = await helpers.prisma.tenant.patrolRun.findFirstOrThrow({
      where: { routeId: route.id },
      orderBy: { plannedAt: 'asc' },
    });
    return {
      bCheckpointId: checkpoint.id,
      bRouteId: route.id,
      bRunId: run.id,
    };
  });
}
