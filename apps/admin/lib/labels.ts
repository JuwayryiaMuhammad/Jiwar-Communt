import type { Tone } from '@jiwar/ui';

/** Security events worth a second look get a warm tone. */
const ALERTING = new Set([
  'otp.verify_failed',
  'otp.rate_limited',
  'otp.challenge_exhausted',
  'platform.login_failed',
  'platform.login_locked',
  'session.refresh_reuse_detected',
  'invite.token_invalid',
]);

/** Event names the backend records (securityEvents.record calls). */
export const SECURITY_EVENTS = [
  'login.succeeded',
  'otp.verify_failed',
  'otp.rate_limited',
  'otp.challenge_exhausted',
  'platform.login_succeeded',
  'platform.login_failed',
  'platform.login_locked',
  'session.revoked',
  'session.refresh_reuse_detected',
  'invite.token_invalid',
  'account.phone_reassigned',
] as const;

export function isAlerting(event: string) {
  return ALERTING.has(event);
}

export function eventTone(event: string): Tone {
  if (event === 'platform.login_locked' || event === 'session.refresh_reuse_detected') return 'error';
  return ALERTING.has(event) ? 'terracotta' : 'beige';
}

/** Actions written to platform_audit_log. */
export const PLATFORM_ACTIONS = [
  'tenant.created',
  'tenant.status_changed',
  'tenant.manager_added',
  'tenant.settings_changed',
  'platform_admin.created',
  'platform_admin.password_changed',
  'role.permissions_synced',
] as const;
