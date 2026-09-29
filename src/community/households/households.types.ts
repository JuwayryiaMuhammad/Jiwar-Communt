import type { HouseholdMemberStatus, HouseholdRelation } from '@prisma/client';

// Service-level shapes (no endpoints yet; HTTP shapes come with the design).

export interface NewInvite {
  fullName: string;
  phone: string;
  /** Required: the acceptance code goes to this address and nowhere else. */
  email: string;
  nationalId: string;
  relation: HouseholdRelation;
}

export interface CreatedInvite {
  inviteId: string;
  /** Shown once. Only its HMAC is stored; the inviter shares the link. */
  token: string;
  expiresAt: Date;
}

export interface NewMinor {
  fullName: string;
  nationalId: string;
  relation: HouseholdRelation;
}

export interface HouseholdMemberView {
  id: string;
  unitId: string;
  /** Null for minors: they have no account. */
  accountId: string | null;
  fullName: string | null;
  relation: HouseholdRelation;
  isMinor: boolean;
  status: HouseholdMemberStatus;
  createdAt: Date;
}

export interface AcceptedInvite {
  accountId: string;
  memberId: string;
  membershipStatus: HouseholdMemberStatus;
}
