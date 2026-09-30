import type { IdentityDocumentInput } from '../../core/common/identity-document';
import type {
  AccountStatus,
  HouseholdRelation,
  IdDocumentType,
  Locale,
  OccupancyEndReason,
  OccupancyStatus,
  OccupancyType,
  UnitReviewReason,
  UnitType,
} from '@prisma/client';

// Service-level shapes (Phase 1a has no resident endpoints; HTTP shapes come
// with the design).

export interface OccupancyInput {
  unitId: string;
  occupancyType: OccupancyType;
  /** Owners only: false = owner-landlord (ADR 0020). Tenants always reside. */
  resides?: boolean;
}

export interface NewResident extends IdentityDocumentInput {
  fullName: string;
  phone: string;
  email: string;
  preferredLocale?: Locale;
  /** At least one (ADR 0012). */
  units: OccupancyInput[];
}

export interface OccupancyView {
  id: string;
  unitId: string;
  unitCode: string;
  occupancyType: OccupancyType;
  /** False for an owner-landlord (ADR 0020). */
  resides: boolean;
  /** The unit's primary resident (ADR 0016). */
  isPrimary: boolean;
  status: OccupancyStatus;
  startedAt: Date;
  endedAt: Date | null;
  endReason: OccupancyEndReason | null;
  handedOverAt: Date | null;
}

export interface ResidentView {
  id: string;
  /** Personal fields are null on an erased account (ADR 0023). */
  fullName: string | null;
  idDocumentType: IdDocumentType | null;
  idDocumentNumber: string | null;
  nationality: string | null;
  /** `YYYY-MM-DD`; null only on legacy accounts. */
  birthDate: string | null;
  /** Null only while frozen (ADR 0023). */
  phone: string | null;
  email: string | null;
  status: AccountStatus;
  preferredLocale: Locale;
  /** Active and ended, oldest first. */
  occupancies: OccupancyView[];
}

export interface MyUnit {
  /** Null for a household member (a family account). */
  occupancyId: string | null;
  /** Set for a household member only. */
  memberId: string | null;
  /** The caller's place in the unit. */
  capacity: OccupancyType | 'member';
  /** Lives there: false only for an owner-landlord (ADR 0020). */
  resides: boolean;
  /** The caller is this unit's primary resident (ADR 0016). */
  isPrimary: boolean;
  /** For the primary only: the household at a glance. */
  household?: { memberCount: number; pendingInvites: number };
  unitId: string;
  code: string;
  building: string | null;
  floor: number | null;
  /** Null for a household member. */
  occupancyType: OccupancyType | null;
  startedAt: Date;
}

/** A unit whose household needs the manager's attention (ADR 0016). */
export interface UnitNeedingReview {
  flagId: string;
  unitId: string;
  code: string;
  /** Why it was flagged (ADR 0021). */
  reason: UnitReviewReason;
  flaggedAt: Date;
  /** Occupants still there (one of them may become the primary). */
  activeOccupants: number;
}

/** An active occupant of a unit, for managers. */
export interface UnitOccupant {
  occupancyId: string;
  account: { id: string; fullName: string | null; status: AccountStatus };
  occupancyType: OccupancyType;
  resides: boolean;
  isPrimary: boolean;
  startedAt: Date;
}

/** A unit as its viewer may see it; `management` only for managers. */
export interface UnitDetail {
  id: string;
  code: string;
  building: string | null;
  floor: number | null;
  unitType: UnitType | null;
  /** Decimal string. */
  areaSqm: string | null;
  closed: boolean;
  createdAt: Date;
  management?: {
    reviewReasons: UnitReviewReason[];
    occupants: UnitOccupant[];
  };
}

/** A member whose permissions predate the current primary (ADR 0021). */
export interface MemberToReview {
  memberId: string;
  accountId: string | null;
  fullName: string | null;
  relation: HouseholdRelation;
  isMinor: boolean;
}
