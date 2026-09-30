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
};
