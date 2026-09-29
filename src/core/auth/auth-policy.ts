import type { AccountType } from '@prisma/client';

export interface SessionPolicy {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

const FIFTEEN_MINUTES = 15 * 60;
const THIRTY_DAYS = 30 * 24 * 60 * 60;

/**
 * Token lifetimes per account type (ADR 0004). Identical in Phase 0; the
 * journeys want shorter sessions for sensitive roles (accountant, system
 * admin, control room), which then becomes a change to this table only.
 */
export const SESSION_POLICY: Record<AccountType, SessionPolicy> = {
  resident: {
    accessTtlSeconds: FIFTEEN_MINUTES,
    refreshTtlSeconds: THIRTY_DAYS,
  },
  staff: { accessTtlSeconds: FIFTEEN_MINUTES, refreshTtlSeconds: THIRTY_DAYS },
  manager: {
    accessTtlSeconds: FIFTEEN_MINUTES,
    refreshTtlSeconds: THIRTY_DAYS,
  },
};
