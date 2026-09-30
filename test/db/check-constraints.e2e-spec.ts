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
  accounts_identity_document: {},
  audit_log_actor_id_matches_type: {},
  domestic_workers_ban_is_complete: {},
  domestic_workers_birth_date_verification: {},
  domestic_workers_identity_document: {},
  household_delegations_end_has_reason: {},
  household_delegations_expiry_within_a_year: {},
  household_delegations_not_to_self: {},
  household_delegations_scopes_not_empty: {},
  household_invites_accepted_has_account: {},
  household_invites_identity_document: {},
  household_members_removed_has_reason: {},
  household_members_removed_matches_status: {},
  outbox_messages_attempts_non_negative: {},
  outbox_messages_sent_at_matches_status: {},
  outbox_messages_stripped_only_when_dead: {},
  platform_audit_log_actor_id_matches_type: {},
  tenant_settings_max_household_members_range: {},
  unit_occupancies_ended_at_matches_status: {},
  unit_occupancies_end_reason_matches_status: {},
  unit_occupancies_handover_after_end: {},
  unit_occupancies_primary_resides: {},
  unit_occupancies_primary_since_matches: {},
  unit_occupancies_tenant_resides: {},
  unit_review_flags_clear_is_complete: {},
  unit_review_flags_manager_reason: {},
  worker_wage_obligations_settled_by_needs_time: {},
  worker_engagements_code_matches_status: {},
  worker_engagements_management_suspension: {},
  worker_engagements_temporary_has_end: {},
  // Compares nullable columns.
  household_members_minor_or_account: {
    guarded:
      'id_document_type and nationality are tested IS NOT NULL first, and ' +
      'the comparison is wrapped in COALESCE(…, false). Rows with each ' +
      'NULL are rejected in identity-and-outbox-schema.e2e-spec.ts',
  },
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
    ]);
  });
});
