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
  // A duplicate key is replayed by the service; never a response.
  visitor_passes_tenant_id_host_account_id_idempotency_key_key: null,
};
