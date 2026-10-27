/** The kinds of common area (ADR 0064); the migration's CHECK repeats them. */
export const COMMON_AREA_KINDS = ['building', 'area', 'facility'] as const;
export type CommonAreaKind = (typeof COMMON_AREA_KINDS)[number];

/** A short code the compound writes on its plans, unique per compound. */
export const AREA_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const AREA_NAME = { min: 1, max: 80 };
export const BUILDING_NAME = { min: 1, max: 80 };
export const LATITUDE = { min: -90, max: 90 };
export const LONGITUDE = { min: -180, max: 180 };
