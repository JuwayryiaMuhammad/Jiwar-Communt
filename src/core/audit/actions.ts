// ============================================================================
// Audit catalog (ADR 0014)
// ============================================================================
//
// Every state-changing action that is audited, and every security event.
// The target type comes from here, never from callers. `sensitive` lists
// fields of this action recorded only as `{ changed: true }`, on top of the
// global sensitive fields (see personal-data.ts).
//
// Adding an action? Emit it from src/ and cover it in
// test/audit/audit-coverage.e2e-spec.ts — tests fail otherwise.

export interface AuditActionDefinition {
  log: 'tenant' | 'platform';
  target: string;
  sensitive?: readonly string[];
}

export const AUDIT_ACTIONS = {
  'account.created': { log: 'tenant', target: 'account' },
  'account.status_changed': { log: 'tenant', target: 'account' },
  'account.locale_changed': { log: 'tenant', target: 'account' },
  'account.contact_changed': {
    log: 'tenant',
    target: 'account',
    sensitive: ['phone', 'email'],
  },
  'account.frozen': { log: 'tenant', target: 'account', sensitive: ['phone'] },
  'account.reactivated': { log: 'tenant', target: 'account' },
  // deletion (ADR 0023)
  'account.deletion_requested': { log: 'tenant', target: 'account' },
  'account.deletion_cancelled': { log: 'tenant', target: 'account' },
  'account.legal_hold_placed': { log: 'tenant', target: 'account' },
  'account.legal_hold_released': { log: 'tenant', target: 'account' },
  'account.erased': { log: 'tenant', target: 'account' },
  'account.erasure_overdue': {
    log: 'tenant',
    target: 'account_deletion_request',
  },
  'role.permissions_replaced': { log: 'tenant', target: 'role' },
  'role.permissions_synced': { log: 'tenant', target: 'role' },
  'occupancy.created': { log: 'tenant', target: 'occupancy' },
  'occupancy.ended': { log: 'tenant', target: 'occupancy' },
  'occupancy.primary_changed': { log: 'tenant', target: 'occupancy' },
  // capacities (ADR 0020)
  'occupancy.converted': { log: 'tenant', target: 'occupancy' },
  'occupancy.residence_changed': { log: 'tenant', target: 'occupancy' },
  'occupancy.handed_over': { log: 'tenant', target: 'occupancy' },
  'unit.closed_mode_changed': { log: 'tenant', target: 'unit' },
  // self-registration (ADR 0024)
  'unit.details_submitted': { log: 'tenant', target: 'unit' },
  'registration_link.created': { log: 'tenant', target: 'tenant' },
  'registration_link.revoked': { log: 'tenant', target: 'tenant' },
  'resident.self_registered': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'resident.registration_approved': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'resident.registration_rejected': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'resident.registration_expired': {
    log: 'tenant',
    target: 'resident_registration',
  },
  'unit.created': { log: 'tenant', target: 'unit' },
  'unit.household_review_flagged': { log: 'tenant', target: 'unit' },
  'unit.household_review_cleared': { log: 'tenant', target: 'unit' },
  'unit.household_ended': { log: 'tenant', target: 'unit' },
  'unit.ownership_transferred': { log: 'tenant', target: 'unit' },
  'household.permissions_reviewed': { log: 'tenant', target: 'unit' },
  'household.member_majority_reached': {
    log: 'tenant',
    target: 'household_member',
  },
  'household.member_came_of_age': { log: 'tenant', target: 'household_member' },
  'household.permission_granted': { log: 'tenant', target: 'household_member' },
  'household.permission_revoked': { log: 'tenant', target: 'household_member' },
  'household.deferred_action_submitted': {
    log: 'tenant',
    target: 'household_deferred_action',
  },
  'household.deferred_action_decided': {
    log: 'tenant',
    target: 'household_deferred_action',
  },
  'worker.wage_obligation_recorded': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  'tenant.settings_changed': { log: 'tenant', target: 'tenant' },
  // household (ADR 0016)
  'household.invite_created': { log: 'tenant', target: 'household_invite' },
  'household.invite_revoked': { log: 'tenant', target: 'household_invite' },
  'household.invite_accepted': { log: 'tenant', target: 'household_invite' },
  'household.member_added': { log: 'tenant', target: 'household_member' },
  'household.member_approved': { log: 'tenant', target: 'household_member' },
  'household.member_rejected': { log: 'tenant', target: 'household_member' },
  'household.member_removed': { log: 'tenant', target: 'household_member' },
  'household.delegation_created': {
    log: 'tenant',
    target: 'household_delegation',
  },
  'household.delegation_revoked': {
    log: 'tenant',
    target: 'household_delegation',
  },
  'household.delegation_ended': {
    log: 'tenant',
    target: 'household_delegation',
  },
  // domestic workers (ADR 0017)
  'worker.registered': { log: 'tenant', target: 'worker_engagement' },
  'worker.engagement_reviewed': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  'worker.code_reissued': { log: 'tenant', target: 'worker_engagement' },
  'worker.engagement_suspended': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  'worker.engagement_resumed': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  'worker.engagement_ended': { log: 'tenant', target: 'worker_engagement' },
  'worker.banned': { log: 'tenant', target: 'domestic_worker' },
  'worker.unbanned': { log: 'tenant', target: 'domestic_worker' },
  'worker.birth_date_attested': { log: 'tenant', target: 'domestic_worker' },
  'worker.birth_date_corrected': { log: 'tenant', target: 'domestic_worker' },
  'worker.compliance_case_opened': { log: 'tenant', target: 'domestic_worker' },
  'worker.compliance_case_closed': { log: 'tenant', target: 'domestic_worker' },
  'worker.card_incident_reported': {
    log: 'tenant',
    target: 'worker_engagement',
  },
  'worker.card_incident_closed': { log: 'tenant', target: 'worker_engagement' },
  'tenant.created': { log: 'platform', target: 'tenant' },
  'tenant.status_changed': { log: 'platform', target: 'tenant' },
  'tenant.manager_added': { log: 'platform', target: 'account' },
  'platform_admin.created': { log: 'platform', target: 'platform_admin' },
  'platform_admin.password_changed': {
    log: 'platform',
    target: 'platform_admin',
  },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

type ActionsFor<L extends 'tenant' | 'platform'> = {
  [K in AuditAction]: (typeof AUDIT_ACTIONS)[K]['log'] extends L ? K : never;
}[AuditAction];

/** Written to `audit_log`, in the tenant transaction of the action. */
export type TenantAuditAction = ActionsFor<'tenant'>;
/** Written to `platform_audit_log`, in the transaction of the action. */
export type PlatformAuditAction = ActionsFor<'platform'>;

export const SECURITY_EVENTS = [
  'otp.requested',
  'otp.verify_failed',
  'otp.challenge_exhausted',
  'otp.rate_limited',
  'login.succeeded',
  'session.refresh_reuse_detected',
  'session.revoked',
  'platform.login_failed',
  'platform.login_locked',
  'platform.login_succeeded',
  'invite.token_invalid',
  // "Not me" (ADR 0023): the phone left the account.
  'account.phone_reassigned',
  // A registration completed with an unknown or revoked link (ADR 0024).
  'registration.link_invalid',
] as const;

export type SecurityEventName = (typeof SECURITY_EVENTS)[number];
