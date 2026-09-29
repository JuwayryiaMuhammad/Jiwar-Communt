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
  'account.contact_changed': {
    log: 'tenant',
    target: 'account',
    sensitive: ['phone', 'email'],
  },
  'role.permissions_replaced': { log: 'tenant', target: 'role' },
  'role.permissions_synced': { log: 'tenant', target: 'role' },
  'occupancy.created': { log: 'tenant', target: 'occupancy' },
  'occupancy.ended': { log: 'tenant', target: 'occupancy' },
  'occupancy.primary_changed': { log: 'tenant', target: 'occupancy' },
  'unit.created': { log: 'tenant', target: 'unit' },
  'unit.household_review_flagged': { log: 'tenant', target: 'unit' },
  'tenant.settings_changed': { log: 'tenant', target: 'tenant' },
  // household (ADR 0016)
  'household.invite_created': { log: 'tenant', target: 'household_invite' },
  'household.invite_revoked': { log: 'tenant', target: 'household_invite' },
  'household.invite_accepted': { log: 'tenant', target: 'household_invite' },
  'household.member_added': { log: 'tenant', target: 'household_member' },
  'household.member_approved': { log: 'tenant', target: 'household_member' },
  'household.member_rejected': { log: 'tenant', target: 'household_member' },
  'household.member_removed': { log: 'tenant', target: 'household_member' },
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
] as const;

export type SecurityEventName = (typeof SECURITY_EVENTS)[number];
