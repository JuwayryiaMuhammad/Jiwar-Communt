import type { CommunityPlace } from '../../community';
import {
  audienceColumns,
  audienceOf,
  audienceWhere,
  placesIn,
  sees,
} from './audience';

const place = (over: Partial<CommunityPlace> = {}): CommunityPlace => ({
  accountId: 'a',
  unitId: 'u',
  building: 'A',
  role: 'owner',
  rented: false,
  ...over,
});

describe('audience columns (ADR 0040)', () => {
  it('no buildings is the whole compound, both ways', () => {
    expect(audienceColumns({ buildings: null, occupancy: 'owners' })).toEqual({
      audienceBuildings: [],
      audienceOccupancy: 'owners',
    });
    expect(
      audienceOf({ audienceBuildings: [], audienceOccupancy: 'owners' }),
    ).toEqual({ buildings: null, occupancy: 'owners' });
  });

  it('buildings are stored once each, sorted', () => {
    expect(
      audienceColumns({ buildings: ['B', 'A', 'B'], occupancy: 'everyone' })
        .audienceBuildings,
    ).toEqual(['A', 'B']);
  });

  it('sees: any one of the places is enough; placesIn keeps those that are', () => {
    const row = {
      audienceBuildings: ['B'],
      audienceOccupancy: 'owners',
    } as const;
    const here = place({ unitId: 'u1', building: 'A' });
    const there = place({ unitId: 'u2', building: 'B' });
    const rents = place({ unitId: 'u3', building: 'B', role: 'tenant' });
    expect(sees([here], { ...row, audienceBuildings: ['B'] })).toBe(false);
    expect(sees([here, there], { ...row, audienceBuildings: ['B'] })).toBe(
      true,
    );
    expect(
      placesIn([here, there, rents], { ...row, audienceBuildings: ['B'] }),
    ).toEqual([there]);
    expect(
      sees([], { audienceBuildings: [], audienceOccupancy: 'everyone' }),
    ).toBe(false);
  });

  it('audienceWhere says per place what inAudience says: the capacities it meets, its building or none', () => {
    expect(
      audienceWhere([
        place({ role: 'owner', building: 'A' }),
        place({ role: 'family', rented: true, building: null }),
        place({ role: 'family', rented: false, building: 'C' }),
      ]),
    ).toEqual({
      OR: [
        {
          audienceOccupancy: { in: ['everyone', 'owners'] },
          OR: [
            { audienceBuildings: { isEmpty: true } },
            { audienceBuildings: { has: 'A' } },
          ],
        },
        {
          audienceOccupancy: { in: ['everyone', 'tenants'] },
          OR: [{ audienceBuildings: { isEmpty: true } }],
        },
        {
          audienceOccupancy: { in: ['everyone'] },
          OR: [
            { audienceBuildings: { isEmpty: true } },
            { audienceBuildings: { has: 'C' } },
          ],
        },
      ],
    });
    // Nobody's places: nothing matches.
    expect(audienceWhere([])).toEqual({ OR: [] });
  });
});
