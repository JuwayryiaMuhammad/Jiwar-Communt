import { LockdownService } from '../../src/gate/lockdown/lockdown.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** B's security records (ADR 0053): foreign ids for the matrix. */
export interface SecurityOpsWorld {
  /** A lockdown of B's gate, started by B's guard and ended at once. */
  bLockdownId: string;
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
  return { bLockdownId: record.lockdown.id };
}
