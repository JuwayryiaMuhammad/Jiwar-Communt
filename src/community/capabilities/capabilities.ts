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
  'visitors_invite' | 'bookings' | 'tickets' | 'finance' | 'unit_security';

export interface UnitState {
  /** Closed-unit mode (the owner is away). */
  closed: boolean;
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
  | { kind: 'registration'; status: 'pending' | 'approved' | 'rejected' };

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

  financeView: boolean;
  financePay: boolean;
  /** Per operation, decimal string; null = no member cap (occupants). */
  financeCapPerOperation: string | null;
  /** An owner-landlord sees their tenant's financial matters — only those. */
  landlordTenantFinance: boolean;

  governanceVote: boolean;
  governanceBudget: boolean;
  governanceCandidacy: boolean;

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
  financeView: false,
  financePay: false,
  financeCapPerOperation: null,
  landlordTenantFinance: false,
  governanceVote: false,
  governanceBudget: false,
  governanceCandidacy: false,
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
  }
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
    financeView: true,
    financePay: true,
    landlordTenantFinance: landlord,
    governanceVote: owner,
    governanceBudget: owner,
    governanceCandidacy: owner,
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
    financeView: finance !== undefined,
    financePay: finance !== undefined,
    financeCapPerOperation: finance?.capPerOperation ?? null,
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
