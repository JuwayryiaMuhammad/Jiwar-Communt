import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** The operations dashboard (ADR 0079) as the API suites see it: B's rows. */
export interface M24World {
  /** A daily brief of B's. */
  bStaffBriefId: string;
}

export async function m24World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<M24World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  return helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const brief = await tx.staffBrief.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          kind: 'brief',
          day: new Date('2026-01-05T00:00:00Z'),
          contents: { timeZone: 'Africa/Cairo', figures: {}, inbox: {} },
          generatedAt: new Date(),
        },
      });
      return { bStaffBriefId: brief.id };
    }),
  );
}
