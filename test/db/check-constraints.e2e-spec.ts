import { Client } from 'pg';
import { required } from '../setup/test-env';

/**
 * The NULL trap: a CHECK passes when its expression is NULL, and any
 * comparison with a NULL column is NULL. Phase 2.1 shipped one
 * (household_members_minor_or_account, fixed in 20260930100100).
 *
 * Every CHECK in the schema is listed here with its verdict. A new CHECK
 * fails the first test until it is reviewed and added. Nullable columns may
 * appear only in `IS [NOT] NULL` tests, which are never NULL; a constraint
 * that compares a nullable column must say how it is guarded.
 */
const REVIEWED: Record<string, { guarded?: string }> = {
  // Nullable columns only under IS [NOT] NULL, or none at all.
  accounts_erased_shape: {},
  account_deletion_requests_cancelled_matches: {},
  account_deletion_requests_completed_matches: {},
  account_deletion_requests_grace_after_request: {},
  household_invites_stripped_shape: {},
  legal_holds_release_is_complete: {},
  account_freezes_reactivated_by_needs_time: {},
  audit_log_actor_id_matches_type: {},
  domestic_workers_ban_is_complete: {},
  domestic_workers_birth_date_verification: {},
  domestic_workers_identity_document: {},
  household_delegations_end_has_reason: {},
  household_delegations_expiry_within_a_year: {},
  household_delegations_not_to_self: {},
  household_delegations_scopes_not_empty: {},
  household_invites_accepted_has_account: {},
  household_members_removed_has_reason: {},
  household_member_grants_no_minor_finance: {},
  household_member_grants_finance_has_cap: {},
  household_member_grants_revoke_is_complete: {},
  household_deferred_actions_decided_matches_status: {},
  household_deferred_actions_decline_has_reason: {},
  household_members_removed_matches_status: {},
  outbox_messages_attempts_non_negative: {},
  outbox_messages_sent_at_matches_status: {},
  outbox_messages_stripped_only_when_dead: {},
  platform_audit_log_actor_id_matches_type: {},
  tenant_settings_max_household_members_range: {},
  resident_registrations_pii_only_pending: {},
  resident_registrations_decided_matches_status: {},
  resident_registrations_approved_has_account: {},
  resident_registrations_tenant_resides: {},
  unit_occupancies_ended_at_matches_status: {},
  unit_occupancies_end_reason_matches_status: {},
  unit_occupancies_handover_after_end: {},
  unit_occupancies_primary_resides: {},
  unit_occupancies_primary_since_matches: {},
  unit_occupancies_tenant_resides: {},
  unit_review_flags_clear_is_complete: {},
  unit_review_flags_manager_reason: {},
  worker_wage_obligations_settled_by_needs_time: {},
  worker_card_incidents_closed_is_complete: {},
  worker_card_incidents_confiscation_by_manager: {},
  worker_compliance_cases_closed_is_complete: {},
  worker_compliance_cases_report_has_reason: {},
  worker_engagements_code_matches_status: {},
  worker_engagements_management_suspension: {},
  worker_engagements_temporary_has_end: {},
  // Phase 4 (ADR 0027, 0028)
  notifications_target_pair: {},
  notifications_params_object: {},
  idempotency_keys_expiry_after_creation: {},
  idempotency_keys_key_length: {},
  gates_name_not_blank: {},
  guard_shifts_end_is_complete: {},
  visitor_details_not_empty: {},
  visitor_passes_party_size_range: {},
  visitor_passes_window_order: {},
  visitor_passes_schedule_matches_kind: {},
  visitor_passes_code_only_when_active: {},
  visitor_passes_used_matches_status: {},
  visitor_passes_cancel_is_complete: {},
  visitor_passes_idempotency_pair: {},
  tenant_settings_max_active_visitor_passes_range: {},
  tenant_settings_gate_request_timeout_range: {},
  gate_entries_system_has_no_guard: {},
  gate_entries_unconfirmed_is_system_out: {},
  gate_entries_method_matches_direction: {},
  gate_approval_requests_party_size_range: {},
  gate_approval_requests_worker_has_engagement: {},
  gate_approval_requests_decided_matches_status: {},
  gate_approval_requests_expiry_after_creation: {},
  // Phase 4.1 (ADR 0030)
  visitor_passes_token_only_with_code: {},
  // files (ADR 0029): purpose and content_type are NOT NULL enums/text.
  files_content_type_for_purpose: {},
  files_size_for_purpose: {},
  files_ready_matches_finalized: {},
  files_owned_or_attached: {},
  files_attached_is_ready: {},
  domestic_workers_preferred_language: {},
  // Entry credentials (ADR 0031): revoked together; a device name only while live.
  entry_credentials_revoked_together: {},
  entry_credentials_device_name: {
    guarded:
      'device_name IS NULL comes first; the length is compared only for a ' +
      'live credential that has a name.',
  },
  // Compares a nullable column.
  entry_credentials_revoke_reason: {
    guarded:
      'revoke_reason IS NULL comes first; a reason is compared only when ' +
      'there is one, and entry_credentials_revoked_together ties it to revoked_at.',
  },
  worker_engagements_token_only_with_code: {},
  // Compares nullable columns.
  accounts_identity_document: {
    guarded:
      "status = 'erased' comes first; any other status has a non-NULL " +
      'document type and nationality (accounts_erased_shape), so the ' +
      'comparisons are never NULL there',
  },
  household_invites_identity_document: {
    guarded:
      'stripped_at IS NOT NULL comes first; an unstripped invite has a ' +
      'non-NULL type and nationality (household_invites_stripped_shape)',
  },
  units_area_positive: {
    guarded:
      'area_sqm IS NULL is tested first; the comparison runs only on a value',
  },
  resident_registrations_area_positive: {
    guarded:
      'area_sqm IS NULL is tested first; the comparison runs only on a value',
  },
  household_member_grants_cap_positive: {
    guarded:
      'cap_per_operation IS NULL is tested first, so the comparison runs ' +
      'only on a value; finance_has_cap makes finance carry one',
  },
  guard_shifts_end_after_start: {
    guarded:
      'ended_at IS NULL is tested first; the comparison runs only on a value',
  },
  gate_approval_requests_decider_is_household: {
    guarded:
      'decided_by IS NULL is tested first, and the comparison of the ' +
      'nullable decision_source is wrapped in COALESCE(…, false)',
  },
  tenant_settings_visitor_directions_length: {
    guarded:
      'visitor_directions IS NULL is tested first; the length runs only on a value',
  },
  tenant_settings_emergency_phone_e164: {
    guarded:
      'emergency_phone IS NULL is tested first; the pattern runs only on a value',
  },
  // Maintenance (ADR 0032): no nullable column, or only under IS [NOT] NULL.
  ticket_categories_key_shape: {},
  ticket_categories_names_length: {},
  maintenance_settings_ranges: {},
  ticket_counters_last_number_non_negative: {},
  tickets_number_positive: {},
  tickets_location: {},
  tickets_description_length: {},
  tickets_technician_matches_status: {},
  tickets_assigned_at_matches_technician: {},
  tickets_hold_reason_matches_status: {},
  tickets_cancelled_shape: {},
  tickets_cycle_counts: {},
  ticket_status_history_hold_has_reason: {},
  ticket_status_history_cycle_positive: {},
  ticket_assignments_cycle_positive: {},
  ticket_feedback_reason_shape: {},
  ticket_feedback_cycle_positive: {},
  ticket_messages_deleted_shape: {},
  ticket_attachments_cycle_positive: {},
  // Maintenance: compares nullable columns.
  tickets_common_area_length: {
    guarded:
      'common_area IS NULL is tested first; the length runs only on a value',
  },
  tickets_completed_shape: {
    guarded:
      'confirmation_status is compared with IS NOT DISTINCT FROM, which is ' +
      'never NULL; completed_at only under IS NOT NULL',
  },
  tickets_closed_shape: {
    guarded:
      'confirmation_status is compared with IS NOT DISTINCT FROM, which is ' +
      'never NULL; closed_at only under IS NOT NULL',
  },
  tickets_rejected_has_count: {
    guarded:
      'confirmation_status is compared with IS DISTINCT FROM, which is never NULL',
  },
  ticket_status_history_from_shape: {
    guarded:
      'from_status IS NOT NULL is tested in the same branch before it is ' +
      'compared with to_status',
  },
  ticket_assignments_type_shape: {
    guarded:
      'every comparison of from, to and assigned_by sits in a branch that ' +
      'first tests each of them IS NOT NULL',
  },
  ticket_feedback_rating_shape: {
    guarded: 'rating IS NULL is tested first; the range runs only on a value',
  },
  ticket_feedback_comment_shape: {
    guarded: 'comment IS NULL is tested first; the length runs only on a value',
  },
  ticket_messages_body_length: {
    guarded: 'body IS NULL is tested first; the length runs only on a value',
  },
  // Dispatch (ADR 0033): no nullable column, or only under IS [NOT] NULL.
  specialties_key_shape: {},
  specialties_names_length: {},
  maintenance_dispatch_settings_ranges: {},
  ticket_dispatch_attempts_shape: {},
  // Parcels (ADR 0035): no nullable column, or only under IS [NOT] NULL.
  parcel_settings_ranges: {},
  parcels_pieces: {},
  parcels_handover_photo: {},
  parcels_data_cleared: {},
  parcel_credentials_attempt: {},
  parcel_credentials_hashes_while_live: {},
  parcel_events_system_has_no_account: {},
  parcel_events_method: {},
  // Parcels: compare nullable columns.
  parcels_label_name_length: {
    guarded:
      'label_name IS NULL is tested first; the length runs only on a value',
  },
  parcels_reject_reason: {
    guarded:
      'reject_reason IS NULL is tested first; the list runs only on a value',
  },
  parcels_return_reason: {
    guarded:
      'return_reason IS NULL is tested first; the list runs only on a value',
  },
  parcels_status_shape: {
    guarded:
      'return_reason is compared only in the returned branch, which first ' +
      'tests return_reason IS NOT NULL',
  },
  parcels_handed_to: {
    guarded: 'handed_over_method IS NOT NULL is tested before it is compared',
  },
  parcel_credentials_end: {
    guarded:
      'end_reason IS NULL is tested first; the list runs only on a value',
  },
  parcel_credentials_delegate_name: {
    guarded:
      'delegate_name IS NULL is tested first; the length runs only on a value',
  },
  parcel_credentials_revoked_keeps_no_name: {
    guarded:
      'end_reason IS NULL is tested first; the list runs only on a value',
  },
  parcel_events_reason: {
    guarded:
      'reason_code is compared only after reason_code IS NULL, and the ' +
      'other side is IS NOT NULL',
  },
  // Dispatch: compares nullable columns.
  technician_availability_history_from_shape: {
    guarded:
      'from_state IS NULL is tested first; the comparison runs only on a value',
  },
  technician_availability_history_reason_shape: {
    guarded:
      'changed_by_account_id IS NOT NULL is tested in the same branch before ' +
      'it is compared with account_id, so a NULL actor never satisfies it',
  },
  // Visits and the SLA (ADR 0034): no nullable column, or only under
  // IS [NOT] NULL.
  ticket_visits_cycle_positive: {},
  ticket_visits_window: {},
  ticket_visits_proposer_side: {},
  ticket_visits_confirmed_shape: {},
  ticket_visits_consent_shape: {},
  ticket_visits_arrived_shape: {},
  ticket_visits_finished_shape: {},
  ticket_visits_late_shape: {},
  // ADR 0038.
  ticket_visits_arrival_confirmed_shape: {},
  maintenance_settings_visit_hours: {},
  ticket_visit_events_actor_shape: {},
  maintenance_sla_settings_enabled_shape: {},
  sla_targets_ranges: {},
  ticket_sla_events_shape: {},
  ticket_sla_clocks_shape: {},
  // Visits and the SLA: compares nullable columns.
  ticket_visits_receiver_shape: {
    guarded:
      'receiver_kind is compared with IS NOT DISTINCT FROM, which is never ' +
      'NULL; the ids only under IS [NOT] NULL',
  },
  ticket_visits_cancelled_shape: {
    guarded:
      'cancelled_by_side is compared with IS [NOT] DISTINCT FROM, which is ' +
      'never NULL, in branches that test it IS NULL / IS NOT NULL first',
  },
  ticket_visits_previous_not_self: {
    guarded:
      'previous_visit_id IS NULL is tested first, and the comparison is ' +
      'IS DISTINCT FROM, which is never NULL',
  },
  ticket_visit_events_reason_shape: {
    guarded:
      'reason_code IS NULL is tested first; the match runs only on a value',
  },
  ticket_sla_events_reason_shape: {
    guarded:
      'reason_code is only tested IS NOT NULL in the first branch, and the ' +
      'second tests IS NULL before it matches the value',
  },
  household_members_minor_or_account: {
    guarded:
      'id_document_type and nationality are tested IS NOT NULL first, and ' +
      'the comparison is wrapped in COALESCE(…, false). Rows with each ' +
      'NULL are rejected in identity-and-outbox-schema.e2e-spec.ts',
  },
  // Preferences (ADR 0036): nullable columns only under IS [NOT] NULL.
  notification_settings_pause_shape: {},
  outbox_messages_held_shape: {},
  // Preferences: compares nullable columns.
  notification_settings_quiet_shape: {
    guarded:
      'the first conjunct pins quiet_end_minute to be NULL exactly when ' +
      'quiet_start_minute is; the ranges and <> run only under ' +
      'quiet_start_minute IS NULL OR …, where both are values. One NULL ' +
      'fails the first conjunct, and false AND NULL is false',
  },
  // Consents (ADR 0036): no nullable column, or only under IS [NOT] NULL.
  account_consents_code_known: {},
  consent_events_code_known: {},
  consent_events_version_positive: {},
  // Consents: compare nullable columns.
  account_consents_granted_shape: {
    guarded:
      'granted_version >= 1 runs only under granted_version IS NULL OR …, ' +
      'so a NULL version is the true branch; granted_at only under IS NULL',
  },
  consent_events_actor_shape: {
    guarded:
      'actor_account_id <> account_id is in the same AND branch as ' +
      'actor_account_id IS NOT NULL, so a NULL actor makes that branch ' +
      'false (false AND NULL is false); the system branch needs actor_type ' +
      'system, so an account event without an actor fails both',
  },
  // Devices and action tokens (ADR 0036): nullable columns only under
  // IS [NOT] NULL.
  account_freezes_released_shape: {},
  action_tokens_uses_nonnegative: {},
  known_devices_device_type_known: {},
  // Data exports (ADR 0036): nullable columns only under IS [NOT] NULL.
  data_exports_shape: {},
  // The deletion queue (ADR 0036): nullable columns only under
  // IS [NOT] NULL.
  account_deletion_requests_r1_shape: {},
};

interface Check {
  table: string;
  name: string;
  definition: string;
  nullable: string[];
}

describe('CHECK constraints and NULL', () => {
  let db: Client;
  let checks: Check[];

  beforeAll(async () => {
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    const { rows } = await db.query<Check>(`
      SELECT c.conrelid::regclass::text AS table,
             c.conname AS name,
             pg_get_constraintdef(c.oid) AS definition,
             COALESCE(array_agg(a.attname::text ORDER BY a.attname)
                        FILTER (WHERE NOT a.attnotnull), '{}') AS nullable
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'c' AND n.nspname = 'public'
       GROUP BY c.oid, c.conrelid, c.conname`);
    checks = rows;
  });

  afterAll(() => db.end());

  it('every CHECK in the schema has been reviewed for the NULL trap', () => {
    expect(checks.map((c) => c.name).sort()).toEqual(
      Object.keys(REVIEWED).sort(),
    );
  });

  it('nullable columns appear only under IS [NOT] NULL, unless the guard is stated', () => {
    for (const check of checks) {
      const rest = check.definition
        .replace(/'[^']*'/g, "''") // literals are not columns
        .replace(/\b(\w+) IS (NOT )?NULL\b/g, 'true');
      const compared = check.nullable.filter((col) =>
        new RegExp(`\\b${col}\\b`).test(rest),
      );
      if (compared.length === 0) continue;
      expect([check.name, compared, REVIEWED[check.name]?.guarded]).toEqual([
        check.name,
        compared,
        expect.any(String),
      ]);
    }
  });

  it('birth dates are never NULL for workers and household members', async () => {
    const { rows } = await db.query<{ table: string; nullable: string }>(`
      SELECT table_name AS table, is_nullable AS nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'birth_date'
       ORDER BY table_name`);
    expect(rows).toEqual([
      // Legacy (Phase 1a) national IDs that did not parse (ADR 0018).
      { table: 'accounts', nullable: 'YES' },
      { table: 'domestic_workers', nullable: 'NO' },
      { table: 'household_invites', nullable: 'YES' },
      { table: 'household_members', nullable: 'NO' },
      // Present exactly while pending (resident_registrations_pii_only_pending).
      { table: 'resident_registrations', nullable: 'YES' },
    ]);
  });
});
