import type { AccountType } from '@prisma/client';

/** Access-token claims (ADR 0004). No permission lists: those stay server-side. */
export interface AccessTokenClaims {
  /** account id */
  sub: string;
  /** tenant id */
  tid: string;
  /** account type */
  typ: AccountType;
  /** session id: the guard rejects the token once its session is revoked */
  sid: string;
}

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'resident',
  'staff',
  'manager',
  'family',
];
