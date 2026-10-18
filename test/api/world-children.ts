import { HouseholdsService } from '../../src/community/households/households.service';
import type { communityHelpers } from '../setup/community';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** B's children (ADR 0054): foreign ids for the matrix. */
export interface ChildrenWorld {
  /** A minor of B's home. */
  bMinorId: string;
}

export async function childrenWorld(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<ChildrenWorld> {
  const minor = await helpers.as(b, { id: b.ids.owner, type: 'resident' }, () =>
    h.moduleRef.get(HouseholdsService).addMinor(b.homeUnitId, {
      fullName: 'World Child',
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(bornYearsAgo(9)),
      relation: 'child',
    }),
  );
  return { bMinorId: minor.id };
}
