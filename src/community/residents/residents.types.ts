import type { IdentityDocumentInput } from '../../core/common/identity-document';
import type {
  AccountStatus,
  IdDocumentType,
  Locale,
  OccupancyStatus,
  OccupancyType,
} from '@prisma/client';

// Service-level shapes (Phase 1a has no resident endpoints; HTTP shapes come
// with the design).

export interface OccupancyInput {
  unitId: string;
  occupancyType: OccupancyType;
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
  /** The unit's primary resident (ADR 0016). */
  isPrimary: boolean;
  status: OccupancyStatus;
  startedAt: Date;
  endedAt: Date | null;
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
