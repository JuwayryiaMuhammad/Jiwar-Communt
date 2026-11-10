/**
 * The platform's own codes, keyed by the code (lib/labels.ts, `useLabel`
 * overrides): the security events (src/core/audit/actions.ts
 * SECURITY_EVENTS), shown in English as the code itself, and the platform
 * audit log's actions (`log: 'platform'`).
 */
export default {
  // Security events.
  'otp.requested': 'otp.requested',
  'otp.verify_failed': 'otp.verify_failed',
  'otp.challenge_exhausted': 'otp.challenge_exhausted',
  'otp.rate_limited': 'otp.rate_limited',
  'login.succeeded': 'login.succeeded',
  'login.new_device': 'login.new_device',
  'session.refresh_reuse_detected': 'session.refresh_reuse_detected',
  'session.revoked': 'session.revoked',
  'platform.login_failed': 'platform.login_failed',
  'platform.login_locked': 'platform.login_locked',
  'platform.login_succeeded': 'platform.login_succeeded',
  'platform.step_up_requested': 'platform.step_up_requested',
  'platform.step_up_verified': 'platform.step_up_verified',
  'platform.step_up_failed': 'platform.step_up_failed',
  'payment.webhook_rejected': 'payment.webhook_rejected',
  'payment.order_mismatch': 'payment.order_mismatch',
  'payment.amount_mismatch': 'payment.amount_mismatch',
  'payment.verification_contradicted': 'payment.verification_contradicted',
  'payment.duplicate_charge': 'payment.duplicate_charge',
  'invite.token_invalid': 'invite.token_invalid',
  'account.phone_reassigned': 'account.phone_reassigned',
  'registration.link_invalid': 'registration.link_invalid',
  'step_up.requested': 'step_up.requested',
  'step_up.verified': 'step_up.verified',
  'step_up.failed': 'step_up.failed',
  'account.not_me': 'account.not_me',
  'guard_alarm.webhook_rejected': 'guard_alarm.webhook_rejected',
  'gate_call.webhook_rejected': 'gate_call.webhook_rejected',
  // Platform audit actions.
  'tenant.created': 'Tenant created',
  'tenant.status_changed': 'Tenant status changed',
  'tenant.manager_added': 'Tenant manager added',
  'tenant.payment_gateway_set': 'Tenant payment gateway set',
  'tenant.payment_gateway_toggled': 'Tenant payment gateway toggled',
  'platform_admin.created': 'Platform admin created',
  'platform_admin.password_changed': 'Platform admin password changed',
} as const;
