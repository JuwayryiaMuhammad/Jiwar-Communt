import { CheckpointsService } from '../../src/gate/patrols/checkpoints.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** B's patrols (ADR 0052): foreign ids for the matrix. */
export interface PatrolsWorld {
  /** A checkpoint at B's gate. */
  bCheckpointId: string;
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
    return { bCheckpointId: checkpoint.id };
  });
}
