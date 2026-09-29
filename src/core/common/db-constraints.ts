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
  // Technical keys that back composite foreign keys; a violation would mean
  // an id collision, so they stay neutral like primary keys.
  accounts_tenant_id_id_key: null,
  units_tenant_id_id_key: null,
  roles_tenant_id_id_key: null,
  roles_tenant_id_id_kind_key: null,
};
