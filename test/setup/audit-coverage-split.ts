/**
 * The audit catalog is covered by two suites, one scenario per entry:
 * - test/community/audit-coverage.e2e-spec.ts covers the entries listed here
 *   (Phase 2 entries: primary resident, household, delegation, workers,
 *   settings, self-service);
 * - test/community/audit-coverage-2-2.e2e-spec.ts covers PHASE_2_2_COVERAGE
 *   (the Phase 2.2 community completion);
 * - test/audit/audit-coverage.e2e-spec.ts covers every other entry.
 * Each suite fails when one of its entries has no scenario, and this list may
 * only name real catalog entries, so nothing can fall between the two.
 */
export const COMMUNITY_COVERAGE: readonly string[] = [
  'occupancy.primary_changed',
  'unit.household_review_flagged',
  'tenant.settings_changed',
  'household.invite_created',
  'household.invite_revoked',
  'household.invite_accepted',
  'household.member_added',
  'household.member_approved',
  'household.member_rejected',
  'household.member_removed',
  'invite.token_invalid',
  'household.delegation_created',
  'household.delegation_revoked',
  'household.delegation_ended',
  'account.locale_changed',
  'worker.registered',
  'worker.engagement_reviewed',
  'worker.code_reissued',
  'worker.engagement_suspended',
  'worker.engagement_resumed',
  'worker.engagement_ended',
  'worker.banned',
  'worker.unbanned',
  'worker.birth_date_attested',
  'worker.birth_date_corrected',
];

/** Phase 2.2 entries, covered by test/community/audit-coverage-2-2.e2e-spec.ts. */
export const PHASE_2_2_COVERAGE: readonly string[] = [
  'occupancy.converted',
  'occupancy.residence_changed',
  'occupancy.handed_over',
  'unit.closed_mode_changed',
  'unit.household_review_cleared',
  'unit.household_ended',
  'unit.ownership_transferred',
  'household.permissions_reviewed',
  'worker.wage_obligation_recorded',
  'household.member_majority_reached',
  'household.member_came_of_age',
  'worker.compliance_case_opened',
  'worker.compliance_case_closed',
  'worker.card_incident_reported',
  'worker.card_incident_closed',
  'account.frozen',
  'account.reactivated',
  'account.phone_reassigned',
  'unit.details_submitted',
  'registration_link.created',
  'registration_link.revoked',
  'resident.self_registered',
  'resident.registration_approved',
  'resident.registration_rejected',
  'resident.registration_expired',
  'registration.link_invalid',
  'account.deletion_requested',
  'account.deletion_cancelled',
  'account.legal_hold_placed',
  'account.legal_hold_released',
  'account.erased',
  'account.erasure_overdue',
  'household.permission_granted',
  'household.permission_revoked',
  'household.deferred_action_submitted',
  'household.deferred_action_decided',
];

/** Phase 4 (the gate), covered by test/gate/audit-coverage.e2e-spec.ts. */
export const PHASE_4_COVERAGE: readonly string[] = [
  'gate.created',
  'gate.updated',
  'gate.shift_started',
  'gate.shift_ended',
  'gate.instructions_changed',
  'visitor_pass.created',
  'visitor_pass.cancelled',
  'visitor_pass.code_reissued',
  'gate.approval_requested',
  'gate.approval_decided',
  'gate.approval_reversed',
  'gate.approval_withdrawn',
];
