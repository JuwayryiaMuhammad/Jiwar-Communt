import { useLabel, type Tone } from '@jiwar/ui';
import codesAr from '@/messages/ar/codes';
import codesEn from '@/messages/en/codes';

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

/** Event names the backend records (SECURITY_EVENTS in src/core/audit/actions.ts). */
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
  'platform.step_up_requested',
  'platform.step_up_verified',
  'platform.step_up_failed',
  'session.revoked',
  'session.refresh_reuse_detected',
  'invite.token_invalid',
  'registration.link_invalid',
  'step_up.requested',
  'step_up.verified',
  'step_up.failed',
  'account.phone_reassigned',
  'account.not_me',
  'payment.webhook_rejected',
  'payment.order_mismatch',
  'payment.amount_mismatch',
  'payment.verification_contradicted',
  'payment.duplicate_charge',
  'guard_alarm.webhook_rejected',
  'gate_call.webhook_rejected',
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
  'tenant.payment_gateway_set',
  'tenant.payment_gateway_toggled',
  'platform_admin.created',
  'platform_admin.password_changed',
] as const;

const CODE_LABELS = { en: codesEn, ar: codesAr };

/**
 * The words for a security event, a platform action or any other code the
 * platform API returns, in the page's language: the platform's own codes
 * first (messages/codes), then the shared words.
 */
export function useCodeLabel() {
  return useLabel(CODE_LABELS);
}
