import type { IdentityDocumentInput } from '../../core/common/identity-document';
import type { HouseholdMemberStatus, HouseholdRelation } from '@prisma/client';

// Service-level shapes (no endpoints yet; HTTP shapes come with the design).

export interface NewInvite extends IdentityDocumentInput {
  fullName: string;
  phone: string;
  /** Required: the acceptance code goes to this address and nowhere else. */
  email: string;
  relation: HouseholdRelation;
}

export interface CreatedInvite {
  inviteId: string;
  /** Shown once. Only its HMAC is stored; the inviter shares the link. */
  token: string;
  expiresAt: Date;
}

/** National ID or passport (ADR 0018); the birth date decides minority. */
export interface NewMinor extends IdentityDocumentInput {
  fullName: string;
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
