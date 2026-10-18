import { HouseholdsService } from '../../src/community/households/households.service';
import { ChildControlsService } from '../../src/gate/children/child-controls.service';
import { ChildEscortsService } from '../../src/gate/children/child-escorts.service';
import type { communityHelpers } from '../setup/community';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** B's children (ADR 0054): foreign ids for the matrix. */
export interface ChildrenWorld {
  /** A minor of B's home, whose exit control is on. */
  bMinorId: string;
  /** An outside escort of that child. */
  bEscortId: string;
}

export async function childrenWorld(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<ChildrenWorld> {
  const asOwner = <T>(fn: () => Promise<T>) =>
    helpers.as(b, { id: b.ids.owner, type: 'resident' }, fn);
  const minor = await asOwner(() =>
    h.moduleRef.get(HouseholdsService).addMinor(b.homeUnitId, {
      fullName: 'World Child',
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(bornYearsAgo(9)),
      relation: 'child',
    }),
  );
  await asOwner(() =>
    h.moduleRef.get(ChildControlsService).turnOn(b.homeUnitId, minor.id, {
      mayLeaveAlone: false,
      notifyPickups: true,
    }),
  );
  const escort = await asOwner(() =>
    h.moduleRef.get(ChildEscortsService).add(b.homeUnitId, minor.id, {
      kind: 'outside',
      outside: { fullName: 'World Escort', phone: '+201001234567' },
    }),
  );
  return { bMinorId: minor.id, bEscortId: escort.id };
}
