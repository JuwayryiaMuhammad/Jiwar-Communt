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
  'registration.link_invalid',
  'step_up.failed',
  'login.new_device',
  'account.not_me',
]);

/** Event names the backend records (securityEvents.record calls). */
export const SECURITY_EVENTS = [
  'login.succeeded',
  'login.new_device',
  'otp.requested',
  'otp.verify_failed',
  'otp.rate_limited',
  'otp.challenge_exhausted',
  'platform.login_succeeded',
  'platform.login_failed',
  'platform.login_locked',
  'session.revoked',
  'session.refresh_reuse_detected',
  'invite.token_invalid',
  'registration.link_invalid',
  'step_up.requested',
  'step_up.verified',
  'step_up.failed',
  'account.phone_reassigned',
  'account.not_me',
] as const;

export function isAlerting(event: string) {
  return ALERTING.has(event);
}

export function eventTone(event: string): Tone {
  if (event === 'platform.login_locked' || event === 'session.refresh_reuse_detected' || event === 'account.not_me') {
    return 'error';
  }
  return ALERTING.has(event) ? 'terracotta' : 'beige';
}

/** Actions written to platform_audit_log (`log: 'platform'` in the backend's audit catalog). */
export const PLATFORM_ACTIONS = [
  'tenant.created',
  'tenant.status_changed',
  'tenant.manager_added',
  'platform_admin.created',
  'platform_admin.password_changed',
] as const;
