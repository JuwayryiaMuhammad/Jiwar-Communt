import type {
  KinshipDocumentInput,
  KinshipDocumentRead,
} from './kinship-documents';
import type { IdentityDocumentInput } from '../../core/common/identity-document';
import type {
  HouseholdMemberStatus,
  HouseholdRelation,
  MemberPermission,
} from '@prisma/client';

// Service-level shapes; HTTP responses map them through views/ (ADR 0025).

export interface NewInvite extends IdentityDocumentInput {
  fullName: string;
  phone: string;
  /** Required: the acceptance code goes to this address and nowhere else. */
  email: string;
  relation: HouseholdRelation;
  /** Proof of the relation (ADR 0062): the inviter's finalized files. */
  kinshipDocuments?: KinshipDocumentInput[];
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

/** A member's live grant, as the household view shows it to its managers. */
export interface MemberGrantSummary {
  permission: MemberPermission;
  /** Finance only; decimal string. */
  capPerOperation: string | null;
}

/** A pending (non-majority) invite, for the primary or a delegate. */
export interface PendingInviteView {
  id: string;
  fullName: string | null;
  relation: HouseholdRelation;
  expiresAt: Date;
}

/**
 * A unit's household as the caller may see it: members for everyone who
 * sees the household; their grants and the pending invites only for the
 * primary or a `household` delegate (`invites` is null otherwise); the
 * codes of what each member holds, and no more, for the management.
 */
export interface HouseholdView {
  members: (HouseholdMemberView & {
    grants?: MemberGrantSummary[];
    /** Management only: which permissions the member holds, no cap. */
    grantedPermissions?: MemberPermission[];
  })[];
  invites: PendingInviteView[] | null;
}

/** A membership waiting for the manager's approval. */
export interface PendingMember {
  memberId: string;
  unitId: string;
  unitCode: string;
  fullName: string | null;
  relation: HouseholdRelation;
  requestedAt: Date;
  /** The invite's proof of kinship, to read before deciding (ADR 0062). */
  kinshipDocuments: KinshipDocumentRead[];
}
