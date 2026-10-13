import { inAudience, type CommunityPlace } from './engagement-port';

const place = (over: Partial<CommunityPlace> = {}): CommunityPlace => ({
  accountId: 'a',
  unitId: 'u',
  building: 'A',
  role: 'owner',
  rented: false,
  ...over,
});

const ROLES = [
  place({ role: 'owner' }),
  // A landlord: an owner of a rented unit.
  place({ role: 'owner', rented: true }),
  place({ role: 'tenant', rented: true }),
  // A member of an owner's household, and of a tenant's.
  place({ role: 'family' }),
  place({ role: 'family', rented: true }),
];

describe('inAudience (ADR 0040)', () => {
  it('everyone: every place in the compound', () => {
    for (const p of ROLES)
      expect(inAudience(p, { buildings: null, occupancy: 'everyone' })).toBe(
        true,
      );
  });

  it('owners: the owners, landlords included, and nobody else', () => {
    expect(
      ROLES.map((p) => inAudience(p, { buildings: null, occupancy: 'owners' })),
    ).toEqual([true, true, false, false, false]);
  });

  it("tenants: the tenants and the members of a rented unit's household", () => {
    expect(
      ROLES.map((p) =>
        inAudience(p, { buildings: null, occupancy: 'tenants' }),
      ),
    ).toEqual([false, false, true, false, true]);
  });

  it('buildings: only the units of the named buildings, combined with the capacity', () => {
    const audience = { buildings: ['A', 'C'], occupancy: 'everyone' } as const;
    expect(inAudience(place({ building: 'A' }), audience)).toBe(true);
    expect(inAudience(place({ building: 'C' }), audience)).toBe(true);
    expect(inAudience(place({ building: 'B' }), audience)).toBe(false);
    expect(
      inAudience(place({ building: 'A', role: 'tenant', rented: true }), {
        buildings: ['A'],
        occupancy: 'owners',
      }),
    ).toBe(false);
    expect(
      inAudience(place({ building: 'B' }), {
        buildings: ['A'],
        occupancy: 'owners',
      }),
    ).toBe(false);
  });

  it('a unit without a building is in whole-compound audiences only', () => {
    const nowhere = place({ building: null });
    expect(inAudience(nowhere, { buildings: null, occupancy: 'owners' })).toBe(
      true,
    );
    expect(inAudience(nowhere, { buildings: ['A'], occupancy: 'owners' })).toBe(
      false,
    );
  });
});
