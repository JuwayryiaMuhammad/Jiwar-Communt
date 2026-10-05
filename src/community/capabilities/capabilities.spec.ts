import {
  capabilitiesFor,
  NONE,
  type Capabilities,
  type Subject,
  type UnitState,
} from './capabilities';

const OPEN: UnitState = { closed: false, reviewReasons: [] };

function occ(
  over: Partial<Extract<Subject, { kind: 'occupancy' }>> = {},
): Subject {
  return {
    kind: 'occupancy',
    occupancyType: 'owner',
    resides: true,
    isPrimary: false,
    status: 'active',
    handedOverAt: null,
    ...over,
  };
}

function member(
  over: Partial<Extract<Subject, { kind: 'member' }>> = {},
): Subject {
  return {
    kind: 'member',
    status: 'active',
    isMinor: false,
    hasAccount: true,
    grants: [],
    ...over,
  };
}

/** Only the flags that are true (plus the cap), for readable expectations. */
function on(c: Capabilities): string[] {
  return Object.entries(c)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort();
}

describe('capabilitiesFor', () => {
  it('owner-resident: daily life, governance, finance', () => {
    const c = capabilitiesFor(occ(), OPEN);
    expect(c).toMatchObject({
      householdView: true,
      visitorsInvite: true,
      bookings: true,
      tickets: true,
      financePay: true,
      governanceVote: true,
      governanceBudget: true,
      governanceCandidacy: true,
      ownershipCard: false,
      landlordTenantFinance: false,
      closedUnitCard: false,
    });
  });

  it('owner-landlord: governance and the tenant’s finances — never the household, visitors or daily services', () => {
    const c = capabilitiesFor(occ({ resides: false }), OPEN);
    expect(c).toMatchObject({
      landlordTenantFinance: true,
      financeView: true,
      governanceVote: true,
      householdView: false,
      householdManage: false,
      visitorsInvite: false,
      visitorsNotify: false,
      bookings: false,
      tickets: false,
      unitSecurity: false,
      activityVisibleToPrimary: false,
    });
  });

  it('tenant: no voting, no budget; the ownership card', () => {
    const c = capabilitiesFor(occ({ occupancyType: 'tenant' }), OPEN);
    expect(c).toMatchObject({
      governanceVote: false,
      governanceBudget: false,
      governanceCandidacy: false,
      ownershipCard: true,
      householdView: true,
      financePay: true,
    });
  });

  it('occupant of a closed unit: the owner with the closed-unit card', () => {
    expect(
      capabilitiesFor(occ(), { closed: true, reviewReasons: [] })
        .closedUnitCard,
    ).toBe(true);
    // A tenant never gets it.
    expect(
      capabilitiesFor(occ({ occupancyType: 'tenant' }), {
        closed: true,
        reviewReasons: [],
      }).closedUnitCard,
    ).toBe(false);
  });

  it('owner of several units: each occupancy is evaluated on its own', () => {
    const here = capabilitiesFor(occ({ isPrimary: true }), OPEN);
    const there = capabilitiesFor(occ({ resides: false }), OPEN);
    expect(here.householdManage).toBe(true);
    expect(there.householdManage).toBe(false);
    expect(there.householdView).toBe(false);
  });

  it('primary-only decisions: end the lease, transfer ownership, remove an occupant', () => {
    expect(capabilitiesFor(occ({ isPrimary: true }), OPEN)).toMatchObject({
      endLease: true,
      transferOwnership: true,
      removeOccupant: true,
      contactPrimary: false,
    });
    expect(capabilitiesFor(occ(), OPEN)).toMatchObject({
      endLease: false,
      transferOwnership: false,
      removeOccupant: false,
      contactPrimary: true,
    });
    // A tenant primary ends leases but never transfers ownership.
    expect(
      capabilitiesFor(occ({ occupancyType: 'tenant', isPrimary: true }), OPEN),
    ).toMatchObject({ endLease: true, transferOwnership: false });
  });

  it('after leaving: archive view only, warranty claims, emergency until handover', () => {
    const ended = capabilitiesFor(occ({ status: 'ended' }), OPEN);
    expect(on(ended)).toEqual(['archiveView', 'emergency', 'warrantyClaims']);
    const handed = capabilitiesFor(
      occ({ status: 'ended', handedOverAt: new Date() }),
      OPEN,
    );
    expect(on(handed)).toEqual(['archiveView', 'warrantyClaims']);
  });

  it('pending registration: documents and emergency, nothing else', () => {
    expect(
      on(capabilitiesFor({ kind: 'registration', status: 'pending' }, OPEN)),
    ).toEqual(['documentsUpload', 'emergency']);
    expect(
      capabilitiesFor({ kind: 'registration', status: 'rejected' }, OPEN),
    ).toEqual(NONE);
  });

  it('adult member: each grant switches exactly its flag; the baseline is always there', () => {
    const bare = capabilitiesFor(member(), OPEN);
    expect(bare).toMatchObject({
      emergency: true,
      conductGuide: true,
      contactPrimary: true,
      visitorsNotify: true,
      visitorsInvite: false,
      bookings: false,
      tickets: false,
      financePay: false,
      unitSecurity: false,
      governanceVote: false,
      documentsUpload: false,
      householdManage: false,
      activityVisibleToPrimary: true,
    });
    const granted = capabilitiesFor(
      member({
        grants: [
          { permission: 'visitors_invite', capPerOperation: null },
          { permission: 'finance', capPerOperation: '500.00' },
        ],
      }),
      OPEN,
    );
    expect(granted).toMatchObject({
      visitorsInvite: true,
      financePay: true,
      financeView: true,
      financeCapPerOperation: '500.00',
      bookings: false,
    });
  });

  it('minor: emergency and the conduct guide — never money, visitors or services', () => {
    const c = capabilitiesFor(
      member({
        isMinor: true,
        hasAccount: false,
        grants: [{ permission: 'finance', capPerOperation: '1.00' }],
      }),
      OPEN,
    );
    expect(on(c)).toEqual(['conductGuide', 'contactPrimary', 'emergency']);
  });

  it('pending or removed member: nothing', () => {
    expect(capabilitiesFor(member({ status: 'removed' }), OPEN)).toEqual(NONE);
    expect(
      capabilitiesFor(member({ status: 'pending_approval' }), OPEN),
    ).toEqual(NONE);
  });

  it('death under review: every financial flag stops for everyone; visitors, tickets and emergency continue', () => {
    const state: UnitState = {
      closed: false,
      reviewReasons: ['primary_deceased'],
    };
    for (const s of [
      occ({ isPrimary: true }),
      occ({ resides: false }),
      member({ grants: [{ permission: 'finance', capPerOperation: '10.00' }] }),
    ]) {
      const c = capabilitiesFor(s, state);
      expect(c).toMatchObject({
        financeView: false,
        financePay: false,
        financeCapPerOperation: null,
        landlordTenantFinance: false,
        householdManage: false,
        emergency: true,
      });
    }
    expect(capabilitiesFor(occ(), state)).toMatchObject({
      tickets: true,
      visitorsNotify: true,
    });
  });

  it('separation: activity is hidden; emergency, tickets and visitor notices stay', () => {
    const state: UnitState = { closed: false, reviewReasons: ['separation'] };
    const c = capabilitiesFor(member(), state);
    expect(c).toMatchObject({
      activityVisibleToPrimary: false,
      emergency: true,
      visitorsNotify: true,
    });
    expect(capabilitiesFor(occ(), state)).toMatchObject({
      visitorsNotify: true,
      tickets: true,
    });
  });

  it('a review for a primary who left or is frozen changes nothing by itself', () => {
    for (const reason of ['primary_left', 'primary_frozen'] as const) {
      expect(
        capabilitiesFor(occ(), { closed: false, reviewReasons: [reason] }),
      ).toEqual(capabilitiesFor(occ(), OPEN));
    }
  });
  it('gateEntry (ADR 0031): who lives there, per capacity — and it survives a death review and a separation', () => {
    const gate = (s: Subject, state: UnitState = OPEN) =>
      capabilitiesFor(s, state).gateEntry;
    // Lives there.
    expect(gate(occ())).toBe(true); // owner-resident
    expect(gate(occ({ occupancyType: 'tenant' }))).toBe(true);
    expect(gate(occ({ isPrimary: true }))).toBe(true);
    expect(gate(occ(), { closed: true, reviewReasons: [] })).toBe(true);
    // An adult member with an account, with or without any grant.
    expect(gate(member())).toBe(true);
    expect(
      gate(
        member({
          grants: [{ permission: 'finance', capPerOperation: '5.00' }],
        }),
      ),
    ).toBe(true);
    // Does not live there, or is not (yet / any more) a member.
    expect(gate(occ({ resides: false }))).toBe(false); // landlord
    expect(gate(occ({ status: 'ended' }))).toBe(false);
    expect(gate(member({ status: 'pending_approval' }))).toBe(false);
    expect(gate(member({ status: 'removed' }))).toBe(false);
    expect(gate(member({ isMinor: true, hasAccount: false }))).toBe(false);
    expect(gate({ kind: 'registration', status: 'pending' })).toBe(false);
    expect(gate({ kind: 'registration', status: 'approved' })).toBe(false);
    // Baseline access to one's home: no review takes it away.
    for (const reason of [
      'primary_deceased',
      'separation',
      'primary_left',
      'primary_frozen',
    ] as const) {
      const state: UnitState = { closed: false, reviewReasons: [reason] };
      expect(gate(occ(), state)).toBe(true);
      expect(gate(member(), state)).toBe(true);
      expect(gate(occ({ resides: false }), state)).toBe(false);
    }
  });

  it('visitConsent (ADR 0034): an adult who lives there — never a landlord, a minor or someone who left', () => {
    const consent = (s: Subject, state: UnitState = OPEN) =>
      capabilitiesFor(s, state).visitConsent;
    // The primary, a residing owner, a residing tenant.
    expect(consent(occ({ isPrimary: true }))).toBe(true);
    expect(consent(occ())).toBe(true);
    expect(consent(occ({ occupancyType: 'tenant' }))).toBe(true);
    // Another adult of the household with an account, whatever their grants.
    expect(consent(member())).toBe(true);
    expect(
      consent(
        member({ grants: [{ permission: 'tickets', capPerOperation: null }] }),
      ),
    ).toBe(true);
    // Never.
    expect(consent(occ({ resides: false }))).toBe(false); // landlord
    expect(consent(occ({ status: 'ended' }))).toBe(false);
    expect(consent(member({ isMinor: true, hasAccount: false }))).toBe(false);
    expect(consent(member({ status: 'pending_approval' }))).toBe(false);
    expect(consent(member({ status: 'removed' }))).toBe(false);
    expect(consent({ kind: 'registration', status: 'pending' })).toBe(false);
    // No review takes it away from someone who lives there.
    for (const reason of [
      'primary_deceased',
      'separation',
      'primary_left',
      'primary_frozen',
    ] as const) {
      const state: UnitState = { closed: false, reviewReasons: [reason] };
      expect(consent(occ(), state)).toBe(true);
      expect(consent(member(), state)).toBe(true);
      expect(consent(occ({ resides: false }), state)).toBe(false);
    }
  });
});
