// ============================================================================
// Patrols (ADR 0052): the pure rules.
// ============================================================================

/** A checkpoint's and a route's names, in either language. */
export const CHECKPOINT_NAME = { min: 1, max: 60 } as const;
export const LATITUDE = { min: -90, max: 90 } as const;
export const LONGITUDE = { min: -180, max: 180 } as const;
/** How near a scan should be to a checkpoint, in metres. */
export const RADIUS_M = { min: 5, max: 500 } as const;
export const DEFAULT_RADIUS_M = 30;
