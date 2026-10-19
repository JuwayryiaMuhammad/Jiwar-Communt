/**
 * Unique indexes → the API fields they protect, for `DUPLICATE_RESOURCE`
 * responses. The driver adapter reports a violation by index name only.
 *
 * Every non-primary-key unique index must be listed (a DB test enforces it).
 * `null` means "report the conflict without naming fields". Primary keys are
 * always neutral: ids are global, so naming the field would confirm that a
 * row exists in another tenant (ADR 0006).
 */
export const UNIQUE_CONSTRAINT_FIELDS: Record<string, string[] | null> = {
  accounts_tenant_id_type_email_key: ['email'],
  accounts_tenant_id_type_phone_key: ['phone'],
  units_tenant_id_code_key: ['code'],
  roles_tenant_id_key_key: ['key'],
  unit_occupancies_one_active_per_unit_account: ['unitId'],
  platform_admins_email_key: ['email'],
  household_members_one_open_per_unit_account: ['accountId'],
  household_delegations_one_live_per_delegate: ['delegateAccountId'],
  worker_engagements_one_open_per_unit: ['unitId'],
  // Resolved by the services before they can fire (primary swap under a unit
  // lock, worker reuse by national-ID hash, code retry); a violation is a
  // race and names nothing — least of all a national ID or an access code.
  unit_occupancies_one_primary_per_unit: null,
  domestic_workers_tenant_id_id_document_hash_key: null,
  worker_engagements_active_code: null,
  household_invites_token_hash_key: null,
  // Technical keys that back composite foreign keys; a violation would mean
  // an id collision, so they stay neutral like primary keys.
  accounts_tenant_id_id_key: null,
  // An account has at most one photo and a photo one account (ADR 0031);
  // the service attaches under the account lock, so a violation is a race.
  accounts_photo_file_id_key: null,
  entry_credentials_tenant_id_id_key: null,
  units_tenant_id_id_key: null,
  roles_tenant_id_id_key: null,
  roles_tenant_id_id_kind_key: null,
  household_members_tenant_id_id_key: null,
  domestic_workers_tenant_id_id_key: null,
  worker_engagements_tenant_id_id_key: null,
  unit_occupancies_tenant_id_id_key: null,
  // Idempotent writers (flag once, record once) check first; a violation is
  // a race and names nothing.
  unit_review_flags_one_open_per_reason: null,
  worker_wage_obligations_one_open_per_kind: null,
  // Checked under the unit's lock first (ADR 0037): WAGE_PERIOD_ALREADY_PAID.
  worker_wage_payments_one_per_period: null,
  household_member_grants_one_live: ['permission'],
  worker_compliance_cases_one_open_per_kind: null,
  account_freezes_one_live: null,
  account_deletion_requests_one_pending: null,
  legal_holds_one_active: null,
  // Upserted by the registration flow (ON CONFLICT); never a response.
  resident_registrations_one_pending_per_email: null,
  // Client-generated (UUIDv7): a violation is an id collision.
  registration_links_id_key: null,
  household_members_tenant_id_id_is_minor_key: null,
  household_members_tenant_id_id_unit_id_is_minor_key: null,
  // The gate (ADR 0028).
  gates_tenant_id_name_key: ['name'],
  gates_tenant_id_id_key: null,
  guard_shifts_tenant_id_id_key: null,
  // Checked first and mapped to SHIFT_ALREADY_OPEN; a violation is a race.
  guard_shifts_one_open_per_guard: null,
  // The roster (ADR 0050): internal keys, never a client's field. A shift
  // fills one slot (taken under the slot's lock); a template makes each of
  // its slots once (checked under the guard's lock).
  guard_roster_templates_tenant_id_id_key: null,
  guard_roster_slots_tenant_id_id_key: null,
  guard_roster_slots_shift_key: null,
  guard_roster_slots_template_start_key: null,
  // The handover (ADR 0050): one per shift, written in the end's
  // transaction.
  guard_handover_items_tenant_id_id_key: null,
  guard_handovers_tenant_id_id_key: null,
  guard_handovers_shift_key: null,
  // Tasks (ADR 0050): a photo is attached to one task, once.
  guard_tasks_tenant_id_id_key: null,
  guard_task_photos_tenant_id_id_key: null,
  guard_task_photos_file_id_key: null,
  // Swaps (ADR 0050): a slot in one live swap at most, decided under the
  // slots' locks first (SWAP_SLOT_BUSY); a violation is a race.
  guard_shift_swaps_tenant_id_id_key: null,
  guard_shift_swaps_live_requester_slot_key: null,
  guard_shift_swaps_live_colleague_slot_key: null,
  // Instructions (ADR 0050): a guard is reached once (a start adds with
  // skipDuplicates).
  guard_instructions_tenant_id_id_key: null,
  guard_instruction_recipients_tenant_id_id_key: null,
  guard_instruction_recipients_once_key: null,
  // The gate's lost and found (ADR 0050).
  found_items_tenant_id_id_key: null,
  found_item_photos_tenant_id_id_key: null,
  found_item_photos_file_id_key: null,
  // Patrols (ADR 0052): two checkpoints in service never share a name.
  patrol_checkpoints_tenant_id_id_key: null,
  patrol_checkpoints_active_name_en_key: ['nameEn'],
  patrol_checkpoints_active_name_ar_key: ['nameAr'],
  // Two routes in service never share a name; a version's number, its
  // current version and its stops are internal keys, written under the
  // route's lock.
  patrol_routes_tenant_id_id_key: null,
  patrol_routes_active_name_en_key: ['nameEn'],
  patrol_routes_active_name_ar_key: ['nameAr'],
  patrol_route_versions_tenant_id_id_key: null,
  patrol_route_versions_number_key: null,
  patrol_route_versions_current_key: null,
  patrol_route_checkpoints_tenant_id_id_key: null,
  patrol_route_checkpoints_position_key: null,
  patrol_route_checkpoints_checkpoint_key: null,
  // Runs: a version makes each scheduled run once (ON CONFLICT DO
  // NOTHING); one live run per guard is checked first and mapped to
  // PATROL_RUN_ALREADY_LIVE: a violation is a race.
  patrol_runs_tenant_id_id_key: null,
  patrol_runs_scheduled_key: null,
  patrol_runs_one_live_per_guard: null,
  // Scans and notes: the app's ids (a collision is a conflict, never a
  // field); each checkpoint once per run and one note per scan are checked
  // under the run's lock first; a photo is attached once.
  patrol_scans_tenant_id_id_key: null,
  patrol_scans_once_per_checkpoint: null,
  patrol_notes_tenant_id_id_key: null,
  patrol_notes_scan_key: null,
  patrol_note_photos_tenant_id_id_key: null,
  patrol_note_photos_file_id_key: null,
  // A point at an instant of a run, once (ON CONFLICT DO NOTHING).
  patrol_track_points_tenant_id_id_key: null,
  patrol_track_points_once_key: null,
  // Children (ADR 0054): one live control per child (checked under the
  // unit's lock first, CHILD_CONTROL_ACTIVE); a card's hash is random.
  child_controls_tenant_id_id_key: null,
  child_controls_tenant_id_id_unit_id_key: null,
  child_controls_one_live_per_member: null,
  child_controls_live_card_key: null,
  // An escort once per person per child (checked under the control's lock
  // first, CHILD_ESCORT_DUPLICATE); a pickup code is derived from a random
  // token, drawn again on a collision.
  child_escorts_tenant_id_id_key: null,
  child_escorts_live_account: null,
  child_escorts_live_engagement: null,
  child_escorts_live_code: null,
  child_escorts_live_qr: null,
  child_pickups_tenant_id_id_key: null,
  // A child registered once per event (checked first: registering again
  // is a no-op).
  event_child_registrations_tenant_id_id_key: null,
  event_child_registrations_once: null,
  visitor_details_tenant_id_id_key: null,
  visitor_passes_tenant_id_id_key: null,
  // ADR 0043.
  unit_standing_instructions_tenant_id_id_key: null,
  // Retried before it can fire; a violation is a race and names no code.
  visitor_passes_active_code: null,
  // A 32-byte random token (ADR 0030): a violation is a broken generator.
  visitor_passes_active_qr: null,
  worker_engagements_active_qr: null,
  // A duplicate key is replayed by the service; never a response.
  visitor_passes_tenant_id_host_account_id_idempotency_key_key: null,
  gate_approval_requests_tenant_id_id_key: null,
  // Server-generated ids (ADR 0029).
  files_tenant_id_id_key: null,
  // A file is attached once: claim() finds no owned file the second time.
  domestic_workers_photo_file_id_key: null,
  // Maintenance (ADR 0032). A category's key is chosen by the manager.
  ticket_categories_tenant_id_key_key: ['key'],
  ticket_categories_tenant_id_id_key: null,
  // ADR 0038. A preventive service's key is chosen by the manager.
  preventive_services_tenant_id_key_key: ['key'],
  preventive_services_tenant_id_id_key: null,
  tickets_tenant_id_id_key: null,
  // Taken from the counter under its row lock; a violation is a race.
  tickets_tenant_id_number_key: null,
  // Checked under the ticket lock (TICKET_INVALID_TRANSITION first).
  ticket_feedback_tenant_id_ticket_id_cycle_kind_key: null,
  // claim() finds no owned file the second time.
  ticket_attachments_file_id_key: null,
  // Dispatch (ADR 0033). A specialty's key is chosen by the manager.
  specialties_tenant_id_key_key: ['key'],
  specialties_tenant_id_id_key: null,
  // The engine writes the notified row under the compound's dispatch lock
  // after checking for one; a violation is a race and names nothing.
  ticket_dispatch_attempts_one_notice_per_cycle: null,
  // Visits and the SLA (ADR 0034). Server-generated ids.
  ticket_visits_tenant_id_id_key: null,
  // Checked under the ticket lock (VISIT_ALREADY_ACTIVE first); a
  // violation is a race and names nothing.
  ticket_visits_one_active_per_ticket: null,
  // ADR 0038. Checked under the ticket lock (TICKET_ALREADY_ESCALATED
  // first); a violation is a race and names nothing.
  ticket_escalations_once_per_cycle: null,
  // The recorder appends under the ticket lock after reading the clock's
  // last event; a violation is a race and names nothing.
  ticket_sla_events_seq_key: null,
  ticket_sla_events_one_start: null,
  ticket_sla_events_one_end: null,
  // Parcels (ADR 0035). Numbers come from the counter under its row lock;
  // codes are derived and checked first, with the indexes as the backstop.
  parcels_tenant_id_id_key: null,
  parcels_tenant_id_number_key: null,
  parcel_credentials_live_code: null,
  parcel_credentials_live_qr: null,
  parcel_credentials_one_holder: null,
  // Checked under the parcel's lock (PARCEL_DELEGATE_EXISTS first).
  parcel_credentials_one_live_delegate: null,
  // Unusual logins (ADR 0036): recorded under the account's row lock, so a
  // violation is a race; server-generated ids.
  known_devices_tenant_id_account_id_device_hash_key: null,
  known_devices_tenant_id_id_key: null,
  // Push (ADR 0041): a token is registered under the account's lock and a
  // lock on the token, and a delivery is queued once with its notification,
  // so a violation is a race; nothing here names a field, least of all a
  // token.
  push_devices_account_id_install_hash_key: null,
  push_devices_token_hash_key: null,
  push_deliveries_notification_id_device_id_key: null,
  // Personal-data export (ADR 0036): checked under the account's row lock
  // (DATA_EXPORT_ACTIVE first), so a violation is a race; server ids.
  data_exports_tenant_id_id_key: null,
  data_exports_one_active: null,
  data_exports_file_id_key: null,
  // Management requests (ADR 0039). A topic's key is the manager's input.
  management_request_topics_tenant_id_key_key: ['key'],
  management_request_topics_tenant_id_id_key: null,
  // Checked when the set of office hours is validated; server-made rows.
  management_office_hours_window_key: null,
  // Numbers come from the counter under its row lock; server ids.
  management_requests_tenant_id_id_key: null,
  management_requests_tenant_id_number_key: null,
  management_request_messages_tenant_id_id_key: null,
  management_request_messages_request_message_key: null,
  // A file is claimed under its row lock before it is attached.
  management_request_attachments_file_id_key: null,
  // Decided under the request's lock; a violation is a race.
  management_request_escalations_once_per_cycle: null,
  management_appointments_one_live_per_request: null,
  // Community life (ADR 0040). A topic's key is the staff's input.
  suggestion_topics_tenant_id_key_key: ['key'],
  suggestion_topics_tenant_id_id_key: null,
  // Server ids and version numbers, written under the announcement's lock.
  announcements_tenant_id_id_key: null,
  announcement_versions_announcement_version_key: null,
  // A file is claimed under its row lock before it is attached.
  announcement_attachments_file_id_key: null,
  community_events_tenant_id_id_key: null,
  event_attachments_file_id_key: null,
  // Written under the event's lock, one answer per account: a race.
  event_rsvps_one_per_account: null,
  polls_tenant_id_id_key: null,
  // Positions are the server's, written with the poll.
  poll_options_position_key: null,
  suggestions_tenant_id_id_key: null,
  suggestion_attachments_file_id_key: null,
  // Neighbours (ADR 0042). A category's key is the manager's input.
  neighbour_complaint_categories_tenant_id_key_key: ['key'],
  neighbour_complaint_categories_tenant_id_id_key: null,
  // Server ids and numbers; the number comes from the counter's row lock.
  neighbour_complaints_tenant_id_id_key: null,
  neighbour_complaints_tenant_id_number_key: null,
  neighbour_complaint_messages_tenant_id_id_key: null,
  neighbour_complaint_messages_complaint_message_key: null,
  // A file is claimed under its row lock before it is attached.
  neighbour_complaint_attachments_file_id_key: null,
  neighbour_complaint_notices_tenant_id_id_key: null,
  // Decided under the complaint's lock; a violation is a race.
  neighbour_complaint_notices_one_per_complaint: null,
  neighbour_posts_tenant_id_id_key: null,
  neighbour_post_photos_file_id_key: null,
  neighbour_item_claims_tenant_id_id_key: null,
  // Decided under the post's lock; a violation is a race.
  neighbour_item_claims_one_pending: null,
  neighbour_item_handovers_one_per_post: null,
  neighbour_item_handovers_claim_id_key: null,
  neighbour_conversations_tenant_id_id_key: null,
  // Each decided under a lock (the pair's, the conversation's): a
  // violation is a race.
  neighbour_conversations_one_per_responder: null,
  neighbour_blocks_one_per_pair: null,
  neighbour_conversation_reports_tenant_id_id_key: null,
  neighbour_conversation_reports_one_per_reporter: null,
  // Skipped on conflict: a household is greeted once.
  neighbour_welcomes_once_per_household: null,
  // Facilities (ADR 0044). A window set is checked for overlaps before it
  // is written, so a duplicate window is a race.
  facilities_tenant_id_id_key: null,
  facility_hours_window_key: null,
  facility_peak_windows_window_key: null,
  bookings_tenant_id_id_key: null,
  // Checked under the unit's lock before the insert: a race.
  bookings_one_holding_per_unit_slot: null,
  facility_closures_tenant_id_id_key: null,
  booking_suspensions_tenant_id_id_key: null,
  // A no-show is marked once (its row lock): a race.
  booking_suspensions_trigger_booking_id_key: null,
  club_plans_tenant_id_id_key: null,
  club_memberships_tenant_id_id_key: null,
  // Inserted with ON CONFLICT DO NOTHING and answered CLUB_MEMBERSHIP_EXISTS.
  club_memberships_one_per_unit: null,
  // Coverage is replaced under the membership's lock: a race.
  club_membership_people_one_open_occupancy: null,
  club_membership_people_one_open_member: null,
  club_payment_records_tenant_id_id_key: null,
  // Checked under the membership's lock first: a race.
  club_payment_records_one_reversal: null,
  // A receipt is recorded once in the compound.
  club_payment_records_receipt_key: ['receiptNumber'],
  // Inserted with ON CONFLICT DO NOTHING.
  club_expiry_reminders_once: null,
  // Vehicles and parking (ADR 0045).
  vehicles_tenant_id_id_key: null,
  // Numbers come from the counter under its row lock: a collision is a bug.
  vehicles_number_key: null,
  // Checked under the plate's advisory lock first (VEHICLE_PLATE_ACTIVE): a race.
  vehicles_one_active_plate: null,
  vehicle_stickers_tenant_id_id_key: null,
  // A sticker number is issued once in the compound; the service answers
  // the same before it can fire.
  vehicle_stickers_number_key: ['stickerNumber'],
  // Backs the vehicle's own sticker foreign key; implied by the one above.
  vehicle_stickers_vehicle_number_key: null,
  // Inserted with ON CONFLICT DO NOTHING.
  vehicle_expiry_reminders_once: null,
  unit_parking_slots_tenant_id_id_key: null,
  // A slot's code is the compound's once.
  unit_parking_slots_code_key: ['code'],
  visitor_parking_areas_tenant_id_id_key: null,
  // An area's name is the compound's once.
  visitor_parking_areas_name_key: ['name'],
  visitor_parking_bookings_tenant_id_id_key: null,
  visitor_parking_bookings_number_key: null,
  vehicle_fines_tenant_id_id_key: null,
  vehicle_fines_number_key: null,
  vehicle_fine_payments_tenant_id_id_key: null,
  // Checked under the fine's lock first: a race.
  vehicle_fine_payments_one_reversal: null,
  // A receipt is recorded once among the compound's fine payments.
  vehicle_fine_payments_receipt_key: ['receiptNumber'],
  parking_reports_tenant_id_id_key: null,
  parking_reports_number_key: null,
  // A report becomes one fine, under its row lock: a race.
  parking_reports_fine_key: null,
  // Finance (ADR 0046). Numbers come from the counter under its row lock and
  // one unit's invoice per batch from one insert: a violation is a race.
  invoice_batches_tenant_id_id_key: null,
  invoices_tenant_id_id_key: null,
  invoices_tenant_id_number_key: null,
  invoices_one_per_batch_unit: null,
  invoice_lines_tenant_id_id_key: null,
  invoice_lines_position_key: null,
  credit_notes_tenant_id_id_key: null,
  credit_notes_tenant_id_number_key: null,
  // Claimed with ON CONFLICT DO NOTHING.
  invoice_notices_once: null,
  billing_plans_tenant_id_id_key: null,
  billing_plan_overrides_tenant_id_id_key: null,
  // Upserted: a violation is a race.
  billing_plan_overrides_one_per_unit: null,
  // The sweep bills under the compound's exclusive lock: a race.
  invoices_one_per_plan_unit_period: null,
  finance_payments_tenant_id_id_key: null,
  // Checked under the unit's finance lock first: a race.
  finance_payments_one_reversal: null,
  // From the counter, and 128 random bits: a violation is a race or a
  // collision, and names nothing.
  finance_payments_receipt_number_key: null,
  finance_payments_receipt_code_key: null,
  finance_allocations_tenant_id_id_key: null,
  payment_sessions_tenant_id_id_key: null,
  payment_sessions_special_reference_key: null,
  // Decided under the unit's finance lock: a violation is a race.
  payment_sessions_one_live_per_unit: null,
  payment_sessions_payment_id_key: null,
  payment_session_invoices_tenant_id_id_key: null,
  payment_session_invoices_once: null,
  payment_gateway_events_tenant_id_id_key: null,
  // The claim: inserted with ON CONFLICT DO NOTHING.
  finance_payments_gateway_transaction_key: null,
  // Emergencies and gate services (ADR 0047).
  places_tenant_id_id_key: null,
  // Only the provisioning writes a key, once per compound.
  places_key_key: null,
  // Two places in service never share a name, in either language.
  places_active_name_en_key: ['nameEn'],
  places_active_name_ar_key: ['nameAr'],
  emergencies_tenant_id_id_key: null,
  // Numbers come from the counter under its row lock: a collision is a bug.
  emergencies_number_key: null,
  // Checked under the unit's emergency lock first, and a violation re-reads
  // the open one: a race.
  emergencies_one_open: null,
  // A guard's SOS (ADR 0053): checked under the post's emergency lock first,
  // like the unit's.
  emergencies_one_open_at_gate: null,
  emergencies_one_open_in_zone: null,
  // The lockdown (ADR 0053): one live per scope is checked under the
  // compound's lockdown row first: a violation is a race.
  gate_lockdowns_tenant_id_id_key: null,
  gate_lockdowns_one_live: null,
  gate_lockdown_overrides_tenant_id_id_key: null,
  // The blocklist (ADR 0053): one live entry per plate and per person,
  // checked under the compound's blocklist lock first, with the same fields.
  blocklist_entries_tenant_id_id_key: null,
  blocklist_entries_live_plate_key: ['plate'],
  blocklist_entries_live_id_key: ['idNumber'],
  blocklist_entries_photo_key: null,
  blocklist_matches_tenant_id_id_key: null,
  // Stop work (ADR 0053): one live per permit, checked under the permit's
  // row lock first.
  permit_work_stops_tenant_id_id_key: null,
  permit_work_stops_one_live: null,
  // Incidents (ADR 0053): numbers come from the counter under its row lock.
  incidents_tenant_id_id_key: null,
  incidents_number_key: null,
  incident_photos_tenant_id_id_key: null,
  incident_photos_file_key: null,
  incident_notes_tenant_id_id_key: null,
  // Violations (ADR 0053), as the fines: a receipt once among the
  // compound's violation payments.
  unit_violations_tenant_id_id_key: null,
  unit_violations_number_key: null,
  unit_violations_photo_key: null,
  unit_violations_appeal_photo_key: null,
  unit_violation_payments_tenant_id_id_key: null,
  unit_violation_payments_one_reversal: null,
  unit_violation_payments_receipt_key: ['receiptNumber'],
  gate_service_requests_tenant_id_id_key: null,
  // Numbers come from the counter under its row lock: a collision is a bug.
  gate_service_requests_number_key: null,
  // Instalment plans (ADR 0048): numbers from the counter, one plan per
  // invoice and one remainder per plan checked under the unit's finance
  // lock, positions from one insert. A violation is a race.
  instalment_plans_tenant_id_id_key: null,
  instalment_plans_tenant_id_number_key: null,
  instalment_plans_one_per_invoice: null,
  instalment_plans_remainder_key: null,
  invoices_instalment_position_key: null,
  // Invoice disputes (ADR 0048): one open per invoice and one credit note
  // per dispute, each checked under the unit's finance lock first.
  invoice_disputes_tenant_id_id_key: null,
  invoice_disputes_one_open: null,
  credit_notes_one_per_dispute: null,
  // Refunds (ADR 0048): numbers from the counter, one reversal per refund
  // and one source per refund and payment, under the unit's finance lock.
  finance_refunds_tenant_id_id_key: null,
  finance_refunds_number_key: null,
  finance_refunds_one_reversal: null,
  finance_refund_sources_tenant_id_id_key: null,
  finance_refund_sources_once: null,
  finance_allocation_releases_tenant_id_id_key: null,
  // Permits (ADR 0049): numbers from the counter under its row lock, a
  // photo claimed once by its owner under the file's row lock. A violation
  // is a bug.
  unit_permits_tenant_id_id_key: null,
  unit_permits_tenant_id_id_kind_key: null,
  unit_permits_number_key: null,
  unit_permits_photo_file_id_key: null,
  permit_workers_tenant_id_id_key: null,
  permit_workers_photo_file_id_key: null,
  permit_guests_tenant_id_id_key: null,
  // Governance (ADR 0051): every write is decided under the compound's
  // board lock (one open term, one seat per account, one chair, secretary
  // and treasurer); a violation is a race the lock lost, and names nothing.
  board_terms_tenant_id_id_key: null,
  board_terms_one_open: null,
  board_terms_one_per_election: null,
  board_members_tenant_id_id_key: null,
  board_members_one_seat: null,
  board_members_one_office: null,
  governance_contests_tenant_id_id_key: null,
  governance_contests_tenant_id_id_secret_key: null,
  // Numbers from the counter under its row lock; one poll per contest.
  governance_polls_tenant_id_id_key: null,
  governance_polls_contest_key: null,
  governance_polls_number_key: null,
  governance_poll_options_tenant_id_id_key: null,
  governance_poll_options_position_key: null,
  governance_elections_tenant_id_id_key: null,
  governance_elections_contest_key: null,
  governance_elections_number_key: null,
  governance_candidates_tenant_id_id_key: null,
  // Standing twice is refused by the service under the contest's lock.
  governance_candidates_one_live: null,
  board_publications_tenant_id_id_key: null,
  board_publications_announcement_key: null,
  // Board matters (ADR 0055). Numbers from the counter under its row lock;
  // one pending request per subject and one open motion per matter are
  // decided under the subject's and the matter's locks (a second pending
  // request answers DUPLICATE_RESOURCE from the service); a vote once per
  // member under the motion's lock; a file is claimed once.
  governance_approval_requests_tenant_id_id_key: null,
  governance_approval_requests_number_key: null,
  governance_approval_requests_one_pending: null,
  governance_approval_requests_motion_key: null,
  governance_approval_attachments_file_key: null,
  board_motions_tenant_id_id_key: null,
  board_motions_one_open_per_request: null,
  board_votes_tenant_id_id_key: null,
  board_votes_once: null,
  // The budget and expenses (ADR 0055): one active and one budget in the
  // making per year, decided under the year's drafting lock; one line per
  // category, checked in the input; an increase and an authorization once
  // per request; numbers from the counter; an invoice claimed once.
  finance_budgets_tenant_id_id_key: null,
  finance_budgets_one_active: null,
  finance_budgets_one_in_progress: null,
  finance_budget_lines_tenant_id_id_key: null,
  finance_budget_lines_category_key: null,
  finance_budget_adjustments_request_key: null,
  finance_expense_authorizations_tenant_id_id_key: null,
  finance_expense_authorizations_request_key: null,
  finance_expenses_tenant_id_id_key: null,
  finance_expenses_number_key: null,
  finance_expenses_invoice_file_key: null,
};
