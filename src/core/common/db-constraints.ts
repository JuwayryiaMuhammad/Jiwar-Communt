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
  // The gate (ADR 0028).
  gates_tenant_id_name_key: ['name'],
  gates_tenant_id_id_key: null,
  guard_shifts_tenant_id_id_key: null,
  // Checked first and mapped to SHIFT_ALREADY_OPEN; a violation is a race.
  guard_shifts_one_open_per_guard: null,
  visitor_details_tenant_id_id_key: null,
  visitor_passes_tenant_id_id_key: null,
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
};
