import type { OccupancyType } from '@prisma/client';

// ============================================================================
// Capabilities (ADR 0020)
// ============================================================================
//
// One pure function that says what someone may do on one unit, from their
// capacity there and the unit's state. Later domains (finance, governance,
// gate, bookings) read these flags; they never re-derive the rules.
//
// Adding a flag? Give it a value for every subject kind below and a case in
// capabilities.spec.ts.

/** Why a unit is under review (ADR 0021); only some change capabilities. */
export type ReviewReason =
  'primary_left' | 'primary_frozen' | 'primary_deceased' | 'separation';

export type MemberPermission =
  | 'visitors_invite'
  | 'bookings'
  | 'tickets'
  | 'finance'
  | 'unit_security'
  | 'polls_vote';

export interface UnitState {
  /** Closed-unit mode (the owner is away). */
  closed: boolean;
  /** No primary lives there now (ADR 0063); unknown counts as not vacant. */
  vacant?: boolean;
  /** Open review flags on the unit. */
  reviewReasons: readonly ReviewReason[];
}

export type Subject =
  | {
      kind: 'occupancy';
      occupancyType: OccupancyType;
      resides: boolean;
      isPrimary: boolean;
      status: 'active' | 'ended';
      handedOverAt: Date | null;
    }
  | {
      kind: 'member';
      status: 'active' | 'pending_approval' | 'removed';
      isMinor: boolean;
      hasAccount: boolean;
      grants: readonly {
        permission: MemberPermission;
        /** Finance only: the cap per operation, as a decimal string. */
        capPerOperation: string | null;
      }[];
    }
  | { kind: 'registration'; status: 'pending' | 'approved' | 'rejected' }
  | {
      kind: 'proxy';
      scopes: readonly ProxyScope[];
      /** Accepted, not ended, not expired. */
      live: boolean;
    };

/**
 * What an owner trusts a unit proxy with (ADR 0063). Never money,
 * contracts, documents, governance, the household, closed mode, moves or
 * events: those have no scope.
 */
export const PROXY_SCOPES = [
  'inspections',
  'tickets',
  'visitors_invite',
  'works',
  'requests',
] as const;
export type ProxyScope = (typeof PROXY_SCOPES)[number];

export interface Capabilities {
  /** Never taken away while the person is in the unit (or its archive, until handover). */
  emergency: boolean;
  conductGuide: boolean;
  contactPrimary: boolean;

  unitView: boolean;
  householdView: boolean;
  /** The primary's own management rights; delegates are checked separately. */
  householdManage: boolean;

  visitorsInvite: boolean;
  /** Receives "a visitor is at the gate". */
  visitorsNotify: boolean;
  bookings: boolean;
  tickets: boolean;
  unitSecurity: boolean;
  /**
   * May hold a rotating entry QR for this unit (ADR 0031): a residing
   * occupant or an active adult member with an account. Never a landlord,
   * a pending or removed member, a minor or an ended occupancy. A death
   * review or a separation does not take it away: it is access to one's home.
   */
  gateEntry: boolean;
  /**
   * May let a maintenance technician enter while nobody is home, for one
   * visit (ADR 0034): an adult who lives there — a residing occupant
   * (owner or tenant) or an active adult member with an account. Never a
   * landlord, a pending or removed member, a minor or an ended occupancy;
   * the caller also requires an active account (frozen and erased ones are
   * refused). Like gateEntry, no review takes it away.
   */
  visitConsent: boolean;
  /**
   * Receives parcels for this unit and may collect, reject or delegate them
   * (ADR 0035): a residing occupant or an active adult member with an
   * account. Never a landlord or non-residing owner, a pending or removed
   * member, a minor or an ended occupancy. A review does not take it away.
   */
  parcels: boolean;
  /**
   * Registers the unit's vehicles and keeps them (ADR 0045): a residing
   * occupant or an active adult member with an account, no grant needed.
   * Never a landlord or non-residing owner, a pending or removed member, a
   * minor or an ended occupancy. A review does not take it away. Losing it
   * removes the vehicles one registered there.
   */
  vehicles: boolean;

  financeView: boolean;
  financePay: boolean;
  /** Per operation, decimal string; null = no member cap (occupants). */
  financeCapPerOperation: string | null;
  /** An owner-landlord sees their tenant's financial matters — only those. */
  landlordTenantFinance: boolean;
  /**
   * Reads the unit's own consumption over its household's tenure (ADR
   * 0069): a residing occupant, or an active adult member the primary gave
   * `finance`. Never a landlord — a tenant's use shows when their home
   * stands empty — a pending or removed member, a minor, a proxy or
   * someone who left. No review takes it away: it is the home's own use.
   */
  consumptionView: boolean;

  governanceVote: boolean;
  governanceBudget: boolean;
  governanceCandidacy: boolean;

  /**
   * Casts the unit's one vote in a consultative poll put to its household
   * (ADR 0040): the primary occupant, or an adult member the primary gave
   * `polls_vote`. Never a landlord, a minor or someone who left. Nothing
   * formal hangs on it (that is governanceVote), so no review takes it away.
   */
  pollsVote: boolean;
  /**
   * Casts the unit's vote in a poll put to the owners only (ADR 0040): any
   * active owner of the unit, landlords included. Never a tenant or a
   * member: an owners' poll is not delegated.
   */
  pollsVoteAsOwner: boolean;

  /** The "ownership" card shown to tenants. */
  ownershipCard: boolean;
  /** Closed-unit card: inspections, agent. */
  closedUnitCard: boolean;

  /** Decisions only the unit's primary occupant takes. */
  endLease: boolean;
  transferOwnership: boolean;
  removeOccupant: boolean;

  /** A member's activity is visible to the primary ("my activity"). */
  activityVisibleToPrimary: boolean;
  /** After leaving: view-only history. */
  archiveView: boolean;
  /** Open warranty claims keep working, even after leaving. */
  warrantyClaims: boolean;
  documentsUpload: boolean;
}

export const NONE: Capabilities = Object.freeze({
  emergency: false,
  conductGuide: false,
  contactPrimary: false,
  unitView: false,
  householdView: false,
  householdManage: false,
  visitorsInvite: false,
  visitorsNotify: false,
  bookings: false,
  tickets: false,
  unitSecurity: false,
  gateEntry: false,
  visitConsent: false,
  parcels: false,
  vehicles: false,
  financeView: false,
  financePay: false,
  financeCapPerOperation: null,
  landlordTenantFinance: false,
  consumptionView: false,
  governanceVote: false,
  governanceBudget: false,
  governanceCandidacy: false,
  pollsVote: false,
  pollsVoteAsOwner: false,
  ownershipCard: false,
  closedUnitCard: false,
  endLease: false,
  transferOwnership: false,
  removeOccupant: false,
  activityVisibleToPrimary: false,
  archiveView: false,
  warrantyClaims: false,
  documentsUpload: false,
});

/** Emergency, the conduct guide and contacting the primary: never revocable. */
const BASELINE = { emergency: true, conductGuide: true, contactPrimary: true };

export function capabilitiesFor(
  subject: Subject,
  unit: UnitState,
): Capabilities {
  const caps = base(subject, unit);
  return applyUnitState(caps, unit);
}

function base(subject: Subject, unit: UnitState): Capabilities {
  switch (subject.kind) {
    case 'registration':
      // Under review: nothing but documents and emergency.
      return subject.status === 'pending'
        ? { ...NONE, emergency: true, documentsUpload: true }
        : { ...NONE };
    case 'occupancy':
      return occupancy(subject, unit);
    case 'member':
      return member(subject);
    case 'proxy':
      return proxy(subject, unit);
  }
}

/**
 * A unit proxy (ADR 0063): only while the unit is closed or has no
 * primary, the unit's view and what its scopes give; never the emergency
 * button, the household or anything else.
 */
function proxy(
  p: Extract<Subject, { kind: 'proxy' }>,
  unit: UnitState,
): Capabilities {
  if (!p.live || !(unit.closed || unit.vacant === true)) return { ...NONE };
  return {
    ...NONE,
    conductGuide: true,
    unitView: true,
    tickets: p.scopes.includes('tickets'),
    visitorsInvite: p.scopes.includes('visitors_invite'),
  };
}

function occupancy(
  o: Extract<Subject, { kind: 'occupancy' }>,
  unit: UnitState,
): Capabilities {
  if (o.status === 'ended') {
    // Archive: view only; open warranty claims continue; the emergency
    // button stays until the unit is handed over.
    return {
      ...NONE,
      emergency: o.handedOverAt === null,
      archiveView: true,
      warrantyClaims: true,
    };
  }
  const owner = o.occupancyType === 'owner';
  const landlord = owner && !o.resides;
  const daily = !landlord; // people who live there
  return {
    ...NONE,
    ...BASELINE,
    contactPrimary: !o.isPrimary,
    unitView: true,
    householdView: daily,
    householdManage: o.isPrimary,
    visitorsInvite: daily,
    visitorsNotify: daily,
    bookings: daily,
    tickets: daily,
    unitSecurity: daily,
    gateEntry: daily,
    visitConsent: daily,
    parcels: daily,
    vehicles: daily,
    financeView: true,
    financePay: true,
    landlordTenantFinance: landlord,
    consumptionView: daily,
    governanceVote: owner,
    governanceBudget: owner,
    governanceCandidacy: owner,
    pollsVote: o.isPrimary,
    pollsVoteAsOwner: owner,
    ownershipCard: !owner,
    closedUnitCard: owner && unit.closed,
    endLease: o.isPrimary,
    transferOwnership: o.isPrimary && owner,
    removeOccupant: o.isPrimary,
    warrantyClaims: true,
    documentsUpload: true,
  };
}

function member(m: Extract<Subject, { kind: 'member' }>): Capabilities {
  if (m.status !== 'active') return { ...NONE };
  if (m.isMinor || !m.hasAccount) {
    // A minor has no account (ADR 0016): emergency and the conduct guide,
    // nothing that spends, invites or buys.
    return { ...NONE, ...BASELINE };
  }
  const has = (p: MemberPermission) => m.grants.some((g) => g.permission === p);
  const finance = m.grants.find((g) => g.permission === 'finance');
  return {
    ...NONE,
    ...BASELINE,
    unitView: true,
    householdView: true,
    visitorsInvite: has('visitors_invite'),
    visitorsNotify: true,
    bookings: has('bookings'),
    tickets: has('tickets'),
    unitSecurity: has('unit_security'),
    gateEntry: true,
    visitConsent: true,
    parcels: true,
    vehicles: true,
    financeView: finance !== undefined,
    financePay: finance !== undefined,
    financeCapPerOperation: finance?.capPerOperation ?? null,
    consumptionView: finance !== undefined,
    pollsVote: has('polls_vote'),
    activityVisibleToPrimary: true,
  };
}

function applyUnitState(caps: Capabilities, unit: UnitState): Capabilities {
  let out = caps;
  if (unit.reviewReasons.includes('primary_deceased')) {
    // Everything financial stops until the capacity is settled; permissions
    // are frozen (no grant, no revocation) — the household guard enforces it.
    out = {
      ...out,
      financeView: false,
      financePay: false,
      financeCapPerOperation: null,
      landlordTenantFinance: false,
      householdManage: false,
    };
  }
  if (unit.reviewReasons.includes('separation')) {
    // The transparency tool must not become a pressure tool. Visitor
    // notices keep reaching everyone.
    out = { ...out, activityVisibleToPrimary: false };
  }
  return out;
}
