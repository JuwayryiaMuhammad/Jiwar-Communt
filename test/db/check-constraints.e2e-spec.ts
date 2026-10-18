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
  push_deliveries_attempts_non_negative: {},
  push_deliveries_sent_at_matches_status: {},
  push_devices_token_present: {},
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
  visitor_passes_entries_used_range: {},
  unit_standing_instructions_description_length: {},
  gates_phone_e164: {
    guarded: 'phone IS NULL is tested first; the pattern runs only on a value',
  },
  visitor_passes_used_when_full: {},
  visitor_passes_token_seq_range: {
    guarded:
      'token_seq IS NULL is tested first; the range runs only on a value',
  },
  visitor_details_vehicle_plate_length: {
    guarded:
      'vehicle_plate IS NULL is tested first; the length runs only on a value',
  },
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
  tenant_settings_office_phone_e164: {
    guarded:
      'office_phone IS NULL is tested first; the pattern runs only on a value',
  },
  tenant_settings_duty_phone_e164: {
    guarded:
      'duty_phone IS NULL is tested first; the pattern runs only on a value',
  },
  // Maintenance (ADR 0032): no nullable column, or only under IS [NOT] NULL.
  ticket_categories_key_shape: {},
  ticket_categories_names_length: {},
  maintenance_settings_ranges: {},
  ticket_counters_last_number_non_negative: {},
  tickets_number_positive: {},
  tickets_location: {},
  tickets_description_length: {
    guarded:
      'description is NULL only on a preventive ticket ' +
      '(tickets_description_unless_preventive, ADR 0038), where no length ' +
      'is asked of it; any description there is has 1 to 2000 characters',
  },
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
  // Management requests (ADR 0039): no nullable column outside IS [NOT] NULL.
  management_request_topics_key_shape: {},
  management_request_topics_names_length: {},
  management_request_topics_target: {},
  management_request_settings_ranges: {},
  management_office_hours_window: {},
  management_requests_number_positive: {},
  management_requests_cycle: {},
  management_request_messages_erased_shape: {},
  management_request_messages_staff_flags: {},
  management_request_messages_cycle_positive: {},
  management_request_escalations_cycle_positive: {},
  management_request_ratings_rating: {},
  management_appointments_window: {},
  // Management requests: compare nullable columns.
  management_requests_on_behalf: {
    guarded:
      'on_behalf_reason IS NULL is tested first; the list runs only on a value',
  },
  management_requests_closed_shape: {
    guarded:
      'close_reason IS NULL is tested first; the list runs only on a value. ' +
      'The other terms are IS [NOT] NULL tests and status, which is NOT NULL',
  },
  management_requests_close_reason_side: {
    guarded:
      'close_reason IS NULL and closed_by_side IS NULL are tested first; the ' +
      'comparisons run only when both have a value',
  },
  management_requests_answered_at: {},
  management_request_messages_body_length: {
    guarded: 'body IS NULL is tested first; the length runs only on a value',
  },
  management_request_ratings_comment_length: {
    guarded: 'comment IS NULL is tested first; the length runs only on a value',
  },
  management_appointments_end_shape: {
    guarded:
      'cancel_reason IS NULL is tested first; the list runs only on a value. ' +
      'The other terms are IS [NOT] NULL tests and status, which is NOT NULL',
  },
  management_appointments_confirmed_at: {},
  // Community life (ADR 0040).
  engagement_settings_ranges: {},
  suggestion_topics_key_shape: {},
  suggestion_topics_names_length: {},
  announcements_version_positive: {},
  announcements_pin_is_important: {},
  announcements_expiry: {
    guarded:
      'expires_at IS NULL is tested first, and publish_at IS NULL before the ' +
      'two are compared',
  },
  announcements_works_shape: {},
  announcements_works_window: {
    guarded:
      'works_starts_at IS NULL and works_ends_at IS NULL are tested first; ' +
      'the comparison runs only on two values',
  },
  announcements_works_gate: {
    guarded:
      'works_gate_id IS NULL is tested first, and works_area_kind IS NOT NULL ' +
      'before it is compared',
  },
  announcements_works_place_length: {
    guarded:
      'works_place IS NULL is tested first; the length runs only on a value',
  },
  announcements_audience_buildings: {},
  announcements_out_first: {},
  announcement_versions_version_positive: {},
  announcement_versions_languages: {},
  announcement_versions_lengths: {
    guarded: 'each text IS NULL is tested first; a length runs only on a value',
  },
  announcement_versions_attachments: {},
  announcement_read_marks_ref_length: {},
  community_events_languages: {},
  community_events_lengths: {
    guarded:
      'each nullable text IS NULL is tested first; a length runs only on a ' +
      'value. place is NOT NULL',
  },
  community_events_window: {},
  community_events_capacity: {
    guarded: 'capacity IS NULL is tested first; the range runs only on a value',
  },
  community_events_audience_buildings: {},
  community_events_attachments: {},
  community_events_cancelled: {
    guarded:
      'cancel_reason IS NULL is tested first; the list runs only on a value. ' +
      'The other term compares two IS NULL tests',
  },
  event_rsvps_guests: {},
  polls_question: {
    guarded:
      'each question IS NULL is tested first; a length runs only on a value',
  },
  polls_window: {},
  polls_audience_buildings: {},
  polls_end_shape: {
    guarded:
      'final_turnout IS NULL is tested first; the comparison runs only on a ' +
      'value. The other terms are IS [NOT] NULL tests',
  },
  polls_salt_length: {
    guarded:
      'ballot_salt IS NULL is tested first; the length runs only on a value',
  },
  poll_options_label: {
    guarded:
      'each label IS NULL is tested first; a length runs only on a value',
  },
  poll_options_position: {},
  poll_options_final_count: {
    guarded:
      'final_count IS NULL is tested first; the comparison runs only on a value',
  },
  poll_ballot_boxes_is_object: {},
  suggestions_body_or_erased: {},
  suggestions_lengths: {
    guarded: 'each text IS NULL is tested first; a length runs only on a value',
  },
  suggestions_response_time: {},
  suggestions_published_summary: {},
  suggestions_done_shape: {},
  suggestion_updates_response_length: {
    guarded:
      'response IS NULL is tested first; the length runs only on a value',
  },
  // Dispatch: compares nullable columns.
  technician_availability_history_from_shape: {
    guarded:
      'from_state IS NULL is tested first; the comparison runs only on a value',
  },
  technician_availability_history_reason_shape: {
    guarded:
      'changed_by_account_id IS NOT NULL is tested in the same branch before ' +
      'it is compared with account_id, and again before to_state (NOT NULL) ' +
      'is compared, so a NULL actor satisfies neither: the system always ' +
      'needs a reason_code',
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
  tickets_unit_location_unit_only: {},
  ticket_escalations_cycle_positive: {},
  // ADR 0038. kind is NOT NULL: every `=` compares two real booleans.
  tickets_preventive_shape: {},
  tickets_description_unless_preventive: {},
  tickets_requested_window: {
    guarded:
      'both times are NULL together, on a repair only ' +
      '(tickets_preventive_shape); a preventive ticket has both',
  },
  preventive_services_key_shape: {},
  preventive_services_names_length: {},
  preventive_services_position_range: {},
  ticket_feedback_technician_rating_shape: {
    guarded:
      'technician_rating IS NULL is tested first; the range runs only on a ' +
      'value, and kind is NOT NULL',
  },
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
  // Wages (ADR 0037).
  worker_wage_payments_period_is_month: {},
  worker_wage_payments_amount_range: {},
  worker_engagements_monthly_wage_range: {
    guarded:
      'monthly_wage IS NULL is tested first; the range runs only on a value',
  },
  // Settled by a manager (ADR 0037): nullable columns only under
  // IS [NOT] NULL.
  worker_wage_obligations_settled_shape: {},
  // Neighbours (ADR 0042): no nullable column outside IS [NOT] NULL.
  neighbour_settings_ranges: {},
  neighbour_complaint_categories_key_shape: {},
  neighbour_complaint_categories_names_length: {},
  neighbour_complaint_counters_not_negative: {},
  neighbour_complaints_number_positive: {},
  neighbour_complaints_closed_shape: {},
  neighbour_complaint_status_history_reason: {},
  neighbour_complaint_messages_erased_shape: {},
  neighbour_complaint_messages_internal_is_staff: {},
  neighbour_complaint_notices_body_length: {},
  neighbour_posts_expires_after_creation: {},
  neighbour_conversations_two_people: {},
  neighbour_conversation_messages_erased_shape: {},
  neighbour_blocks_two_people: {},
  neighbour_conversation_reports_reason: {},
  neighbour_welcome_templates_whole_per_language: {},
  // Neighbours: compare nullable columns.
  neighbour_complaints_not_own_unit: {
    guarded:
      'author_unit_id IS NULL is tested first; the comparison runs only on ' +
      'a value, and target_unit_id is NOT NULL',
  },
  neighbour_complaints_close_reason: {
    guarded:
      'close_reason IS NULL is tested first; the lists run only on a value, ' +
      'and status is NOT NULL',
  },
  neighbour_complaints_close_reason_side: {
    guarded:
      'close_reason IS NULL and closed_by_side IS NULL are tested first; the ' +
      'comparisons run only when both have a value',
  },
  neighbour_complaint_status_history_move: {
    guarded:
      'from_status is compared only in the branch that first tests ' +
      'from_status IS NOT NULL; the other branch is from_status IS NULL',
  },
  neighbour_complaint_messages_body_length: {
    guarded: 'body IS NULL is tested first; the length runs only on a value',
  },
  neighbour_posts_erased_shape: {},
  neighbour_posts_text_length: {
    guarded:
      'body IS NULL and place IS NULL are tested first; each length runs ' +
      'only on a value',
  },
  neighbour_posts_author_shape: {},
  neighbour_posts_closed_shape: {
    guarded:
      'close_reason IS NULL is tested first; the list runs only on a value. ' +
      'The other terms are IS [NOT] NULL tests and status, which is NOT NULL',
  },
  neighbour_item_claims_note_length: {
    guarded: 'note IS NULL is tested first; the length runs only on a value',
  },
  neighbour_item_claims_decided_shape: {
    guarded:
      'decline_reason IS NULL is tested first; the list runs only on a ' +
      'value. The other terms are IS [NOT] NULL tests and status, which is ' +
      'NOT NULL',
  },
  neighbour_conversations_closed_shape: {
    guarded:
      'close_reason IS NULL is tested first; the list runs only on a value',
  },
  neighbour_conversation_messages_body_length: {
    guarded: 'body IS NULL is tested first; the length runs only on a value',
  },
  neighbour_conversation_reports_note_length: {
    guarded: 'note IS NULL is tested first; the length runs only on a value',
  },
  neighbour_conversation_reports_closed_shape: {
    guarded:
      'outcome IS NULL is tested first; the list runs only on a value. The ' +
      'other terms are IS [NOT] NULL tests and status, which is NOT NULL',
  },
  neighbour_welcome_templates_text_length: {
    guarded:
      'each text IS NULL is tested first; its length runs only on a value',
  },
  // Facilities (ADR 0044).
  facilities_names_length: {},
  facilities_position_range: {},
  // Nullable rules only under IS [NOT] NULL; mode and the two flags are NOT NULL.
  facilities_rules_shape: {},
  facilities_descriptions_length: {
    guarded:
      'each description IS NULL is tested first; its length runs only on a value',
  },
  facilities_rules_ranges: {
    guarded:
      'each rule IS NULL is tested first; its range runs only on a value',
  },
  facilities_peak_quota_within_weekly: {
    guarded:
      'peak_quota IS NULL and weekly_quota IS NULL are tested first; the comparison runs only on two values',
  },
  facility_hours_window: {},
  facility_peak_windows_window: {},
  bookings_window: {},
  bookings_party: {},
  // Nullable columns only under IS [NOT] NULL; status is NOT NULL.
  bookings_state_shape: {},
  bookings_cancelled_by: {
    guarded:
      'cancelled_side IS NULL is tested first; the comparison runs only on a value',
  },
  bookings_cancel_reason: {
    guarded:
      'cancel_reason IS NULL is tested first; the lists run only on a value, by cancelled_side, which the state shape sets with it',
  },
  bookings_reject_reason: {
    guarded:
      'reject_reason IS NULL is tested first; the list runs only on a value',
  },
  bookings_closure: {
    guarded:
      'closure_id IS NULL is tested first; with a closure the state shape has set the side and the reason',
  },
  facility_closures_window: {},
  facility_closures_reason: {},
  facility_closures_lifted_shape: {},
  facility_closures_lift_reason: {
    guarded:
      'lift_reason_code IS NULL is tested first; the list runs only on a value',
  },
  facility_settings_ranges: {},
  booking_suspensions_window: {},
  booking_suspensions_count: {},
  booking_suspensions_lifted_shape: {},
  booking_suspensions_lift_reason: {
    guarded:
      'lift_reason_code IS NULL is tested first; the list runs only on a value',
  },
  club_plans_names_length: {},
  club_plans_duration: {},
  club_plans_duration_days: {
    guarded:
      'duration_days IS NULL is tested first; the range runs only on a value',
  },
  club_plans_price: {},
  club_membership_people_one_person: {},
  club_membership_people_removed_shape: {},
  // Nullable columns only under IS [NOT] NULL; kind is NOT NULL.
  club_payment_records_kind_shape: {},
  club_payment_records_amount: {
    guarded: 'amount IS NULL is tested first; the range runs only on a value',
  },
  club_payment_records_currency: {
    guarded:
      'currency IS NULL is tested first; the comparison runs only on a value',
  },
  club_payment_records_receipt_shape: {
    guarded:
      'receipt_number IS NULL is tested first; the pattern runs only on a value',
  },
  club_payment_records_period: {
    guarded:
      'period_starts_on IS NULL and period_ends_on IS NULL are tested first; the comparison runs only on two values',
  },
  club_payment_records_reason: {
    guarded:
      'reason_code IS NULL is tested first; the list runs only on a value',
  },
  // Vehicles and parking (ADR 0045).
  vehicle_settings_ranges: {},
  // Permits (ADR 0049): arrays and NOT NULL minutes only.
  permit_settings_work_days: {},
  permit_settings_work_hours: {},
  permit_settings_days_off: {},
  permit_counters_last_number: {},
  unit_permits_number_positive: {},
  unit_permits_window: {},
  // Nullable columns only under IS [NOT] NULL; kind is NOT NULL.
  unit_permits_kind_shape: {},
  unit_permits_daily_hours: {
    guarded:
      'daily_from IS NULL and daily_to IS NULL are tested first; the comparisons run only on values',
  },
  unit_permits_guest_limit: {
    guarded:
      'guest_limit IS NULL is tested first; the range runs only on a value',
  },
  unit_permits_items_shape: {
    guarded: 'items IS NULL is tested first; the shape runs only on a value',
  },
  unit_permits_text_length: {
    guarded:
      'each text IS NULL is tested first; the length runs only on a value',
  },
  unit_permits_text_cleared: {},
  unit_permits_purged: {},
  unit_permits_work_type: {
    guarded: 'work_type IS NULL is tested first; the list runs only on a value',
  },
  unit_permits_reject_reason: {
    guarded:
      'reject_reason IS NULL is tested first; the list runs only on a value',
  },
  unit_permits_revoke_reason: {
    guarded:
      'revoke_reason IS NULL is tested first; the list runs only on a value',
  },
  unit_permits_cancel: {
    guarded:
      'cancel_side IS NULL is tested first; cancel_reason IS NULL or IS NOT NULL before each list',
  },
  unit_permits_cancel_reason_side: {},
  unit_permits_decision: {
    guarded:
      'decision_source IS NULL is tested first; the comparisons run only on a value',
  },
  // Nullable columns only under IS [NOT] NULL; status is NOT NULL.
  unit_permits_state_shape: {},
  permit_workers_kind: {},
  permit_workers_purged: {},
  permit_workers_text: {
    guarded:
      'each text IS NULL is tested first; the length and pattern run only on a value',
  },
  permit_workers_removal: {
    guarded:
      'removed_side IS NULL is tested first; remove_reason IS NULL or IS NOT NULL before its list',
  },
  permit_guests_kind: {},
  material_entries_description_length: {},
  permit_guests_purged: {},
  permit_guests_text: {
    guarded:
      'each text IS NULL is tested first; the length runs only on a value',
  },
  vehicle_counters_last_number: {},
  vehicles_number_positive: {},
  vehicles_text_length: {},
  vehicles_version_positive: {},
  // Nullable columns only under IS [NOT] NULL; status is NOT NULL.
  vehicles_state_shape: {},
  vehicles_removed_by: {
    guarded:
      'removal_side IS NULL is tested first; the comparison runs only on a value',
  },
  vehicles_sticker_shape: {
    guarded:
      'sticker_number IS NULL is tested first; the pattern runs only on a value',
  },
  vehicles_rejection_reason: {
    guarded:
      'rejection_reason IS NULL is tested first; the list runs only on a value',
  },
  vehicles_removal_reason: {
    guarded:
      'removal_reason IS NULL is tested first; the lists run only on a value, by removal_side, which the state shape sets with it',
  },
  vehicle_stickers_number_shape: {},
  unit_parking_slots_text_length: {},
  visitor_parking_areas_name_length: {},
  visitor_parking_areas_capacity: {},
  visitor_parking_bookings_number_positive: {},
  visitor_parking_bookings_window: {},
  // Nullable columns only under IS [NOT] NULL.
  visitor_parking_bookings_visitor: {},
  visitor_parking_bookings_visitor_name_length: {
    guarded:
      'visitor_name IS NULL is tested first; the length runs only on a value',
  },
  // Nullable columns only under IS [NOT] NULL; status is NOT NULL.
  visitor_parking_bookings_state_shape: {},
  visitor_parking_bookings_cancelled_by: {
    guarded:
      'cancel_side IS NULL is tested first; the comparison runs only on a value',
  },
  visitor_parking_bookings_cancel_reason: {
    guarded:
      'cancel_reason IS NULL is tested first; the lists run only on a value, by cancel_side, which the state shape sets with it',
  },
  vehicle_fines_number_positive: {},
  vehicle_fines_plate_length: {},
  vehicle_fines_note_length: {
    guarded: 'note IS NULL is tested first; the length runs only on a value',
  },
  vehicle_fines_amount: {},
  vehicle_fines_reason: {},
  // Nullable columns only under IS [NOT] NULL.
  vehicle_fines_appeal_shape: {},
  vehicle_fines_appeal_text_length: {
    guarded:
      'appeal_text IS NULL is tested first; the length runs only on a value',
  },
  vehicle_fines_decision_shape: {},
  // Nullable columns only under IS [NOT] NULL; status is NOT NULL.
  vehicle_fines_state_shape: {},
  vehicle_fines_accepted_cancels: {
    guarded:
      'appeal_decision IS NULL is tested first; the comparison runs only on a value',
  },
  vehicle_fines_cancel_reason: {
    guarded:
      'cancel_reason IS NULL is tested first; the list runs only on a value',
  },
  // Nullable columns only under IS [NOT] NULL; kind is NOT NULL.
  vehicle_fine_payments_kind_shape: {},
  vehicle_fine_payments_amount: {
    guarded: 'amount IS NULL is tested first; the range runs only on a value',
  },
  vehicle_fine_payments_currency: {
    guarded:
      'currency IS NULL is tested first; the comparison runs only on a value',
  },
  vehicle_fine_payments_receipt_shape: {
    guarded:
      'receipt_number IS NULL is tested first; the pattern runs only on a value',
  },
  vehicle_fine_payments_reason: {
    guarded:
      'reason_code IS NULL is tested first; the list runs only on a value',
  },
  parking_reports_number_positive: {},
  parking_reports_text_length: {},
  parking_reports_note_length: {
    guarded: 'note IS NULL is tested first; the length runs only on a value',
  },
  parking_reports_note_cleared: {},
  // Nullable columns only under IS [NOT] NULL; status is NOT NULL.
  parking_reports_state_shape: {},
  parking_reports_close_reason: {
    guarded:
      'close_reason IS NULL is tested first; the list runs only on a value',
  },
  // Finance (ADR 0046).
  finance_gateways_provider: {},
  finance_gateways_key_version: {},
  finance_gateways_sealed: {
    guarded:
      'wallet_integration_enc IS NULL is tested first; the length runs only on a value',
  },
  finance_gateways_last4: {
    guarded:
      'wallet_integration_last4 IS NULL is tested first; the length runs only on a value',
  },
  finance_gateways_wallet_shape: {},
  // updated_by_platform is NOT NULL; the account only under IS NULL.
  finance_gateways_updated_by_shape: {},
  finance_counters_kind: {},
  finance_counters_last_number: {},
  // Nullable columns only under IS [NOT] NULL; target is NOT NULL.
  invoice_batches_target_shape: {},
  invoice_batches_building_length: {
    guarded:
      'building IS NULL is tested first; the length runs only on a value',
  },
  invoice_batches_unit_count: {},
  invoice_batches_due: {},
  invoices_number: {},
  invoices_total: {},
  invoices_currency: {},
  invoices_due: {},
  invoice_lines_position: {},
  invoice_lines_descriptions: {},
  invoice_lines_amount: {},
  invoice_notices_kind: {},
  credit_notes_number: {},
  credit_notes_amount: {},
  credit_notes_reason: {},
  billing_plans_names_length: {},
  billing_plans_amount: {},
  billing_plans_starts_on: {},
  billing_plans_days: {},
  // excluded is NOT NULL; the amount only under IS NULL.
  billing_plan_overrides_shape: {},
  billing_plan_overrides_amount: {
    guarded: 'amount IS NULL is tested first; the range runs only on a value',
  },
  invoice_batches_plan_shape: {},
  invoices_plan_shape: {},
  // Instalment plans (ADR 0048). invoices_due tests instalment_plan_id only
  // under IS NULL (its CASE); the cancellation's columns only under IS NULL.
  instalment_plans_number: {},
  instalment_plans_count: {},
  instalment_plans_total: {},
  instalment_plans_cancel_shape: {},
  invoices_instalment_shape: {
    guarded:
      'instalment_position IS NULL is tested first; the range runs only on a value',
  },
  credit_notes_instalment_plan_link: {},
  // Invoice disputes (ADR 0048). The decision's and the clearing's columns
  // only under IS [NOT] NULL; reason_code and status are NOT NULL.
  invoice_disputes_reason: {},
  invoice_disputes_decision_reason: {
    guarded:
      'decision_reason_code IS NULL is tested first; the list runs only on a value',
  },
  invoice_disputes_text_length: {
    guarded: 'text IS NULL is tested first; the length runs only on a value',
  },
  invoice_disputes_decision_shape: {},
  invoice_disputes_cleared_shape: {},
  credit_notes_dispute_link: {},
  // Refunds (ADR 0048), as finance_payments: kind is NOT NULL, the rest
  // only under IS [NOT] NULL in the shape.
  finance_refunds_kind_shape: {},
  finance_refunds_number: {
    guarded: 'number IS NULL is tested first; the range runs only on a value',
  },
  finance_refunds_amount: {
    guarded: 'amount IS NULL is tested first; the range runs only on a value',
  },
  finance_refunds_currency: {
    guarded:
      'currency IS NULL is tested first; the comparison runs only on a value',
  },
  finance_refunds_reference_format: {
    guarded:
      'reference IS NULL is tested first; the pattern runs only on a value',
  },
  finance_refunds_reason: {
    guarded:
      'reason_code IS NULL is tested first; the list runs only on a value',
  },
  finance_refund_sources_amount: {},
  finance_allocation_releases_amount: {},
  // Nullable columns only under IS [NOT] NULL; kind is NOT NULL.
  finance_payments_kind_shape: {},
  finance_payments_office_shape: {
    guarded:
      'channel IS NULL is tested first; the comparisons run only on a payment, whose method is set (kind_shape)',
  },
  finance_payments_reference_shape: {
    guarded:
      'method IS NULL is tested first; the list runs only on a value, the reference under IS NOT NULL',
  },
  finance_payments_reversal_recorder: {},
  finance_payments_amount: {
    guarded: 'amount IS NULL is tested first; the range runs only on a value',
  },
  finance_payments_currency: {
    guarded:
      'currency IS NULL is tested first; the comparison runs only on a value',
  },
  finance_payments_receipt_number: {
    guarded:
      'receipt_number IS NULL is tested first; the range runs only on a value',
  },
  finance_payments_receipt_code_shape: {
    guarded:
      'receipt_code IS NULL is tested first; the pattern runs only on a value',
  },
  finance_payments_reference_format: {
    guarded:
      'reference IS NULL is tested first; the pattern runs only on a value',
  },
  finance_payments_reason: {
    guarded:
      'reason_code IS NULL is tested first; the list runs only on a value',
  },
  finance_allocations_amount: {},
  receipt_links_code_hash_shape: {},
  finance_payments_online_shape: {
    guarded:
      '(channel = online) IS NOT TRUE holds when channel is NULL; the rest runs only on an online payment, whose method is set (kind_shape)',
  },
  finance_payments_offline_shape: {
    guarded:
      '(channel = online) IS TRUE is false when channel is NULL; the rest is IS NULL only',
  },
  finance_payments_transaction_shape: {
    guarded:
      'gateway_transaction_id IS NULL is tested first; the pattern runs only on a value',
  },
  payment_sessions_amount: {},
  payment_sessions_currency: {},
  payment_sessions_reference_shape: {},
  payment_sessions_dedupe_shape: {},
  payment_sessions_secret_shape: {},
  // status is NOT NULL; the nullable columns only under IS [NOT] NULL.
  payment_sessions_status_shape: {},
  payment_session_invoices_amount: {},
  payment_gateway_events_transaction_shape: {},
  payment_gateway_events_order_shape: {
    guarded:
      'gateway_order_id IS NULL is tested first; the pattern runs only on a value',
  },
  payment_gateway_events_outcome: {},
  invoices_period: {
    guarded:
      'period_starts_on IS NULL and period_ends_on IS NULL are tested first; the comparison runs only on two values',
  },
  // Emergencies and gate services (ADR 0047).
  places_key: {
    guarded: 'key IS NULL is tested first; the list runs only on a value',
  },
  places_names_length: {},
  places_position_range: {},
  safety_counters_last_number: {},
  emergencies_number_positive: {},
  emergencies_eta: {
    guarded:
      'eta_minutes IS NULL is tested first; the list runs only on a value',
  },
  emergencies_escalation: {
    guarded:
      'escalation_reason IS NULL is tested first; the list runs only on a value',
  },
  emergencies_accept_shape: {},
  emergencies_close_shape: {},
  // Nullable columns only under IS [NOT] NULL; status is NOT NULL.
  emergencies_state_shape: {},
  emergencies_close_side: {
    guarded:
      'close_side IS NULL is tested first; the comparisons run only on a value',
  },
  emergencies_cancel_reason: {
    guarded:
      'close_reason IS NULL is tested first; the list runs only on a value',
  },
  emergencies_resolve_reason: {
    guarded:
      'close_reason IS NOT NULL is required before the list, so NULL fails',
  },
  emergencies_close_reason_open: {},
  // A guard's SOS (ADR 0053): exactly one of the unit, the gate and the
  // zone, and a shift exactly for a post.
  emergencies_origin: {
    guarded:
      'num_nonnulls counts the NULLs and is never NULL; the shift is compared under IS NULL',
  },
  emergencies_close_note_length: {
    guarded:
      'close_note IS NULL is tested first; the length runs only on a value',
  },
  gate_service_requests_number_positive: {},
  // Nullable columns only under IS [NOT] NULL; kind is NOT NULL.
  gate_service_requests_kind_shape: {},
  gate_service_requests_assistance_kind: {
    guarded:
      'assistance_kind IS NULL is tested first; the list runs only on a value',
  },
  gate_service_requests_when: {
    guarded: 'when_code IS NULL is tested first; the list runs only on a value',
  },
  gate_service_requests_lane_reason: {
    guarded:
      'lane_reason IS NULL is tested first; the list runs only on a value',
  },
  gate_service_requests_close_reason: {
    guarded:
      'close_reason IS NULL is tested first; the list runs only on a value',
  },
  gate_service_requests_eta: {
    guarded:
      'eta_minutes IS NULL is tested first; the list runs only on a value',
  },
  gate_service_requests_text_length: {
    guarded:
      'each text IS NULL is tested first; the length runs only on a value',
  },
  gate_service_requests_text_cleared: {},
  // Nullable columns only under IS [NOT] NULL; status is NOT NULL.
  gate_service_requests_state_shape: {},
  gate_service_requests_cancel: {
    guarded:
      'cancel_side IS NULL is tested first; cancel_reason IS NOT NULL before its list',
  },
  gate_service_requests_cancel_reason_side: {},
  // Guard shifts and tasks (ADR 0050).
  guard_shifts_one_post: { guarded: 'num_nonnulls() counts NULLs: never NULL' },
  guard_shifts_minutes_at_end: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  guard_shifts_minutes_range: { guarded: 'COALESCE() of each: never NULL' },
  guard_roster_templates_one_post: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  guard_roster_templates_until_after_from: {
    guarded: 'effective_until IS NULL is tested first',
  },
  guard_roster_templates_schedule_shape: {},
  guard_roster_templates_end_is_complete: {},
  guard_roster_templates_end_reason: {
    guarded: 'end_reason IS NULL is tested first',
  },
  guard_roster_templates_end_by: {
    guarded: 'end_reason IS NULL is tested first',
  },
  guard_roster_slots_one_post: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  guard_roster_slots_ends_after_start: {},
  guard_roster_slots_at_most_a_day: {},
  guard_roster_slots_made_by: {},
  guard_roster_slots_cancel_is_complete: {},
  guard_roster_slots_cancel_reason: {
    guarded: 'cancel_reason IS NULL is tested first',
  },
  guard_roster_slots_cancelled_by: {
    guarded: 'cancel_reason IS NULL is tested first',
  },
  guard_roster_slots_filled_shape: {},
  guard_roster_slots_late_minutes_range: {
    guarded: 'late_minutes IS NULL is tested first',
  },
  guard_handover_items_label_length: {},
  guard_handover_items_position_range: {},
  guard_handovers_one_post: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  guard_handovers_checklist_shape: {},
  guard_handovers_system_shape: {},
  guard_handovers_notes_length: {
    guarded: 'notes IS NULL is tested first',
  },
  guard_handovers_cleared_shape: {},
  guard_handovers_ack_is_complete: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  guard_handovers_not_own: {
    guarded: 'acknowledged_by_account_id IS NULL is tested first',
  },
  guard_tasks_one_assignee: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  guard_tasks_kind_shape: {},
  guard_tasks_title_length: { guarded: 'title IS NULL is tested first' },
  guard_tasks_details_length: { guarded: 'details IS NULL is tested first' },
  guard_tasks_result_note_length: {
    guarded: 'result_note IS NULL is tested first',
  },
  guard_tasks_taken_shape: {},
  guard_tasks_done_shape: {},
  guard_tasks_outcome: { guarded: 'outcome IS NULL is tested first' },
  guard_tasks_cancel_shape: {},
  guard_tasks_cancel_reason: {
    guarded: 'cancel_reason IS NULL is tested first',
  },
  guard_tasks_cancelled_by: {
    guarded: 'cancel_reason IS NULL is tested first',
  },
  guard_tasks_cleared_shape: {},
  guard_shift_swaps_not_self: {},
  guard_shift_swaps_two_slots: {
    guarded: 'colleague_slot_id IS NULL is tested first',
  },
  guard_shift_swaps_reason_length: {
    guarded: 'reason IS NULL is tested first',
  },
  guard_shift_swaps_cleared_shape: {},
  guard_shift_swaps_accepted_shape: {},
  guard_shift_swaps_decided_shape: {},
  guard_shift_swaps_reject_reason: {
    guarded: 'reject_reason IS NULL is tested first',
  },
  guard_shift_swaps_closed_shape: {},
  guard_shift_swaps_close_reason: {
    guarded: 'close_reason IS NULL is tested first',
  },
  guard_instructions_title_length: {},
  guard_instructions_body_length: {},
  guard_instructions_audience_shape: {},
  guard_instructions_archive_is_complete: {},
  guard_instruction_recipients_ack_after_add: {
    guarded: 'acknowledged_at IS NULL is tested first',
  },
  found_items_description_length: {},
  found_items_location_length: { guarded: 'location IS NULL is tested first' },
  found_items_claim_note_length: {
    guarded: 'claim_note IS NULL is tested first',
  },
  found_items_claimant_name_length: {
    guarded: 'claimant_name IS NULL is tested first',
  },
  found_items_post_shape: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  found_items_found_before_registered: {},
  found_items_received_shape: {},
  found_items_claimed_shape: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  found_items_cleared_shape: {},
  // Governance (ADR 0051).
  board_terms_period: {},
  board_terms_seats: {},
  board_terms_source_shape: {},
  board_terms_end_shape: {
    guarded:
      'ended_at IS NULL and end_reason IS NULL are tested first; the comparison and the list run only on values',
  },
  board_members_end_shape: {
    guarded:
      'ended_at IS NULL is tested first; the comparison runs only on a value',
  },
  board_members_end_reason: {
    guarded:
      'end_reason IS NULL is tested first; the list runs only on a value',
  },
  governance_contests_window: {},
  governance_contests_max_choices: {},
  governance_contests_election_secret: {},
  // Nullable columns only under IS [NOT] NULL.
  governance_contests_state_shape: {},
  governance_contests_counts: {
    guarded:
      'electorate IS NULL and turnout IS NULL are tested first; the comparisons run only on values',
  },
  governance_participations_choice_shape: {
    guarded: 'choice IS NULL is tested first; cardinality runs only on a value',
  },
  governance_ballot_boxes_secret: {},
  governance_ballot_boxes_shape: {},
  governance_ballots_random_id: {},
  governance_ballots_choice: {},
  governance_counters_last_number: {},
  governance_polls_number_positive: {},
  governance_polls_quorum: {},
  governance_polls_threshold: {},
  governance_polls_author_side: {},
  // Nullable columns only under IS [NOT] NULL.
  governance_polls_texts: {},
  governance_polls_text_length: {
    guarded:
      'each text IS NULL is tested first; the length runs only on a value',
  },
  governance_polls_result: {
    guarded:
      'result IS NULL and winning_option_id IS NULL are tested first; the list and the comparison run only on values',
  },
  governance_polls_cancel: {
    guarded:
      'cancel_reason_code IS NULL is tested first; the list runs only on a value',
  },
  governance_poll_options_shape: {
    guarded:
      'key, each label and final_count IS NULL are tested first; the lists, lengths and comparison run only on values',
  },
  governance_elections_number_positive: {},
  governance_elections_seats: {},
  governance_elections_term: {},
  governance_elections_nominations: {},
  governance_elections_author_side: {},
  // Nullable columns only under IS [NOT] NULL.
  governance_elections_texts: {},
  governance_elections_text_length: {
    guarded:
      'each text IS NULL is tested first; the length runs only on a value',
  },
  governance_elections_certified: {
    guarded:
      'tie_reason_code IS NULL is tested first; the list runs only on a value',
  },
  governance_elections_cancel: {
    guarded:
      'cancel_reason_code IS NULL and cancelled_by_account_id IS NULL are tested first; the lists run only on values',
  },
  governance_candidates_statement: {
    guarded:
      'statement IS NULL is tested first; the length runs only on a value',
  },
  governance_candidates_end_shape: {
    guarded:
      'reason_code IS NULL and ended_by_account_id IS NULL are tested before each list; status is NOT NULL',
  },
  board_publications_kind: {},
  board_publications_author_side: {},
  governance_candidates_outcome: {
    guarded:
      'outcome IS NULL and final_count IS NULL are tested first; the list and the comparison run only on values',
  },
  // Patrols (ADR 0052).
  patrol_checkpoints_one_post: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  patrol_checkpoints_names_length: {},
  patrol_checkpoints_position_shape: {},
  patrol_checkpoints_position_range: {
    guarded:
      'lat IS NULL is tested first; position_shape makes lng and radius_m present with it',
  },
  patrol_checkpoints_token_hash_shape: {},
  patrol_checkpoints_retired_shape: {},
  patrol_routes_one_post: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  patrol_routes_names_length: {},
  patrol_routes_retired_shape: {},
  patrol_route_versions_number_positive: {},
  patrol_route_versions_expected_range: {},
  patrol_route_versions_schedule_shape: {
    guarded: 'schedule IS NULL is tested first',
  },
  patrol_route_checkpoints_position_range: {},
  patrol_runs_one_post: {
    guarded: 'num_nonnulls() counts NULLs: never NULL',
  },
  patrol_runs_kind_shape: {},
  patrol_runs_planned: {
    guarded:
      'kind_shape gives a scheduled run its start; started_shape gives every other run its started_at: never both NULL',
  },
  patrol_runs_window_after_start: {
    guarded:
      'scheduled_start IS NULL is tested first; kind_shape gives window_ends_at with it',
  },
  patrol_runs_started_shape: {},
  patrol_runs_ended_shape: {
    guarded: 'started_at IS NULL and ended_at IS NULL are tested first',
  },
  patrol_runs_end_reason: {
    guarded: 'end_reason IS NULL is tested first',
  },
  patrol_runs_cancel_reason: {
    guarded: 'cancel_reason IS NULL is tested first',
  },
  patrol_runs_cancelled_by: {
    guarded: 'cancel_reason IS NULL is tested first',
  },
  patrol_runs_counts: {},
  patrol_runs_completed_shape: {},
  patrol_scans_position_range: {},
  patrol_scans_manual_shape: {
    guarded: 'manual_reason IS NULL is tested first',
  },
  patrol_scans_position_shape: {
    guarded:
      'lat IS NULL and accuracy_m IS NULL are tested first; lng is present with lat',
  },
  patrol_scans_distance_shape: {
    guarded: 'distance_m IS NULL is tested first',
  },
  patrol_notes_outcome: {},
  patrol_notes_text_length: { guarded: 'text IS NULL is tested first' },
  patrol_notes_cleared_shape: {},
  patrol_track_points_position_range: {},
  patrol_track_points_accuracy_range: {
    guarded: 'accuracy_m IS NULL is tested first',
  },
  // The lockdown (ADR 0053).
  gate_lockdowns_reason: {},
  gate_lockdowns_end_shape: {
    guarded:
      'ended_at is compared to started_at only when it is not NULL (the OR); the rest are IS NULL tests',
  },
  gate_lockdowns_end_reason: { guarded: 'end_reason IS NULL is tested first' },
  gate_lockdowns_end_note_length: {
    guarded: 'end_note IS NULL is tested first',
  },
  gate_lockdown_overrides_kind: {},
  // The blocklist (ADR 0053).
  blocklist_entries_kind: {},
  blocklist_entries_subject_shape: {
    guarded:
      'subject is NOT NULL and compared first; every other column only under IS [NOT] NULL',
  },
  blocklist_entries_plate_length: { guarded: 'plate IS NULL is tested first' },
  blocklist_entries_name_length: {
    guarded: 'full_name IS NULL is tested first',
  },
  blocklist_entries_id_hash_shape: {
    guarded: 'id_hash IS NULL is tested first',
  },
  blocklist_entries_note_length: { guarded: 'note IS NULL is tested first' },
  blocklist_entries_reason: {},
  blocklist_entries_lift_shape: {
    guarded:
      'lift_reason is compared only once it is NOT NULL (the IS NULL branch comes first)',
  },
  blocklist_entries_purge_shape: {
    guarded: 'purged_at IS NULL is tested first',
  },
  blocklist_matches_kind: {},
  blocklist_matches_source: {},
  blocklist_matches_outcome: {},
  blocklist_matches_subject: {
    guarded: 'subject_type IS NULL is tested first',
  },
  security_refusals_subject: {},
  // Stop work (ADR 0053).
  permit_work_stops_kind: {},
  permit_work_stops_reason: {},
  permit_work_stops_end_shape: {
    guarded:
      'end_kind and ended_at are compared only once NOT NULL (the IS NULL branches come first)',
  },
  // Incidents (ADR 0053).
  incidents_number_positive: {},
  incidents_type: {},
  incidents_severity: {},
  incidents_where: {
    guarded: 'num_nonnulls counts the NULLs and is never NULL',
  },
  incidents_post: {
    guarded:
      'num_nonnulls counts the NULLs and is never NULL; the rest are IS NULL tests',
  },
  incidents_description: {
    guarded: 'description IS NULL is tested first',
  },
  incidents_state_shape: {},
  incidents_outcome: { guarded: 'outcome IS NULL is tested first' },
  incidents_closing_note: {
    guarded: 'closing_note IS NULL is tested first',
  },
  incident_notes_body: { guarded: 'body IS NULL is tested first' },
  incident_acknowledgements_role: {},
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
