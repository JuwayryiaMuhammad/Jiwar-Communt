/** Platform token lifetimes (ADR 0011): shorter than tenant tokens. */
export const PLATFORM_ACCESS_TTL_SECONDS = 10 * 60;
export const PLATFORM_REFRESH_TTL_SECONDS = 12 * 60 * 60;
/** The restricted token issued while a password change is pending. */
export const PASSWORD_CHANGE_TTL_SECONDS = 10 * 60;

export const PLATFORM_AUDIENCE = 'platform';

export type PlatformScope = 'full' | 'password_change';

export interface PlatformTokenClaims {
  /** platform admin id */
  sub: string;
  scp: PlatformScope;
  /** platform session id; full tokens only */
  sid?: string;
}
