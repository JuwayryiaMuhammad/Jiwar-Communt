import type { IdentityDocumentInput } from '../../core/common/identity-document';
import type {
  AccountStatus,
  IdDocumentType,
  Locale,
  OccupancyEndReason,
  OccupancyStatus,
  OccupancyType,
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
  fullName: string;
  idDocumentType: IdDocumentType;
  idDocumentNumber: string;
  nationality: string;
  /** `YYYY-MM-DD`; null only on legacy accounts. */
  birthDate: string | null;
  phone: string;
  email: string;
  status: AccountStatus;
  preferredLocale: Locale;
  /** Active and ended, oldest first. */
  occupancies: OccupancyView[];
}

export interface MyUnit {
  occupancyId: string;
  /** The caller is this unit's primary resident (ADR 0016). */
  isPrimary: boolean;
  /** For the primary only: the household at a glance. */
  household?: { memberCount: number; pendingInvites: number };
  unitId: string;
  code: string;
  building: string | null;
  floor: number | null;
  occupancyType: OccupancyType;
  startedAt: Date;
}

/** A unit whose household needs the manager's attention (ADR 0016). */
export interface UnitNeedingReview {
  unitId: string;
  code: string;
  /** Why it was flagged, e.g. `primary_left`. */
  reason: string;
  flaggedAt: Date;
  /** Occupants still there (one of them may become the primary). */
  activeOccupants: number;
}
