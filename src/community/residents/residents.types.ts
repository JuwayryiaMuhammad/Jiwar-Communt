import type {
  AccountStatus,
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

export interface NewResident {
  fullName: string;
  nationalId: string;
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
  status: OccupancyStatus;
  startedAt: Date;
  endedAt: Date | null;
}

export interface ResidentView {
  id: string;
  fullName: string;
  nationalId: string;
  phone: string;
  email: string;
  status: AccountStatus;
  preferredLocale: Locale;
  /** Active and ended, oldest first. */
  occupancies: OccupancyView[];
}

export interface MyUnit {
  occupancyId: string;
  unitId: string;
  code: string;
  building: string | null;
  floor: number | null;
  occupancyType: OccupancyType;
  startedAt: Date;
}
