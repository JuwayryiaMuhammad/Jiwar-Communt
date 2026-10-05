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
  // The account's own photo (ADR 0031): never a file id.
  'account.photo_changed': {
    log: 'tenant',
    target: 'account',
    sensitive: ['photo'],
  },
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
  // What the compound tells visitors (ADR 0030): changed, never the text.
  'tenant.settings_changed': {
    log: 'tenant',
    target: 'tenant',
    sensitive: ['visitorDirections', 'emergencyPhone'],
  },
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
  // The photo is recorded as { changed: true } only (ADR 0029).
  'worker.registered': {
    log: 'tenant',
    target: 'worker_engagement',
    sensitive: ['photo'],
  },
  'worker.photo_changed': {
    log: 'tenant',
    target: 'domestic_worker',
    sensitive: ['photo'],
  },
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
  // the gate (ADR 0028)
  'gate.created': { log: 'tenant', target: 'gate' },
  'gate.updated': { log: 'tenant', target: 'gate' },
  'gate.shift_started': { log: 'tenant', target: 'guard_shift' },
  'gate.shift_ended': { log: 'tenant', target: 'guard_shift' },
  'gate.instructions_changed': { log: 'tenant', target: 'unit' },
  // No visitor name, phone or code ever goes into these.
  'visitor_pass.created': { log: 'tenant', target: 'visitor_pass' },
  'visitor_pass.cancelled': { log: 'tenant', target: 'visitor_pass' },
  'visitor_pass.code_reissued': { log: 'tenant', target: 'visitor_pass' },
  // The resident's entry QR (ADR 0031). Ids and a reason code only: never the
  // secret, never the device name. A resident's scan is not audited at all.
  'entry_credential.issued': { log: 'tenant', target: 'entry_credential' },
  'entry_credential.revoked': { log: 'tenant', target: 'entry_credential' },
  'gate.approval_requested': { log: 'tenant', target: 'gate_approval_request' },
  // metadata.decisionSource: household, standing_instruction or timeout.
  'gate.approval_decided': { log: 'tenant', target: 'gate_approval_request' },
  'gate.approval_reversed': { log: 'tenant', target: 'gate_approval_request' },
  'gate.approval_withdrawn': { log: 'tenant', target: 'gate_approval_request' },
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
  // files (ADR 0029): purpose, type and size only, never a file name.
  'file.created': { log: 'tenant', target: 'file' },
  'file.deleted': { log: 'tenant', target: 'file' },
  // maintenance (ADR 0032). Admin actions only: a ticket's own status
  // changes and assignments are its append-only history. Never a
  // description, a common-area label, a comment, a note or a message.
  'ticket_category.created': { log: 'tenant', target: 'ticket_category' },
  'ticket_category.updated': { log: 'tenant', target: 'ticket_category' },
  'maintenance.settings_changed': { log: 'tenant', target: 'tenant' },
  // metadata: categoryKey, priority, location (unit | common_area).
  'ticket.created_on_behalf': { log: 'tenant', target: 'ticket' },
  // changes: priority; metadata: reasonCode.
  'ticket.priority_changed': { log: 'tenant', target: 'ticket' },
  // ADR 0034. changes: categoryKey; metadata: reasonCode.
  'ticket.category_changed': { log: 'tenant', target: 'ticket' },
  // metadata: reasonCode, by (reporter | dispatcher), fromStatus.
  'ticket.cancelled': { log: 'tenant', target: 'ticket' },
  // dispatch (ADR 0033). Codes and keys only, never a name.
  'specialty.created': { log: 'tenant', target: 'specialty' },
  'specialty.updated': { log: 'tenant', target: 'specialty' },
  // changes: specialties (the keys of the set, before and after).
  'ticket_category.specialties_changed': {
    log: 'tenant',
    target: 'ticket_category',
  },
  // target: the technician's account; changes: specialties (keys).
  'technician.specialties_changed': { log: 'tenant', target: 'account' },
  // changes: autoDispatchEnabled, the weights and the multipliers.
  'maintenance.dispatch_settings_changed': { log: 'tenant', target: 'tenant' },
  // visits and the SLA (ADR 0034). Visits are never audited: their window,
  // consent and receiver tell when a home is empty. Minutes and flags only.
  // changes: slaEnabled.
  'maintenance.sla_settings_changed': { log: 'tenant', target: 'tenant' },
  // changes: `<priority>.responseMinutes` / `<priority>.resolutionMinutes`.
  'ticket_category.sla_targets_changed': {
    log: 'tenant',
    target: 'ticket_category',
  },
  // parcels (ADR 0035). Ids, carrier, pieces, a reason code or a method:
  // never a name (the label's, a delegate's), a code, a token or a file id.
  'parcel.received': { log: 'tenant', target: 'parcel' },
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
