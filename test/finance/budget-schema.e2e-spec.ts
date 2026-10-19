import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { newId } from '../../src/core/common/uuid';
import { budgetLineRow, budgetRow, expenseRow } from '../setup/finance-rows';
import { approvalRequestRow } from '../setup/governance-rows';

/**
 * The budget's and expenses' tables (ADR 0055) at the database: what the
 * app may write; a budget keeps its year and moves forward once; its lines
 * change only while it is a draft; increases and authorizations are
 * append-only; an expense keeps its terms and is voided once.
 */
describe('Budget and expenses tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let tenantId: string;
  let accountId: string;
  let draftId: string;
  let draftLineId: string;
  let activeId: string;
  let activeLineId: string;
  let expenseId: string;
  let authorizationId: string;

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Budget schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    await inTx(async (tx) => {
      draftId = await budgetRow(tx, { tenantId, createdById: accountId });
      draftLineId = await budgetLineRow(tx, { tenantId, budgetId: draftId });
      // Written as a draft, then made active: a line only enters a draft.
      activeId = await budgetRow(tx, { tenantId, createdById: accountId });
      activeLineId = await budgetLineRow(tx, { tenantId, budgetId: activeId });
      expenseId = await expenseRow(tx, {
        tenantId,
        lineId: activeLineId,
        recordedById: accountId,
      });
      authorizationId = newId();
      await tx.financeExpenseAuthorization.create({
        data: {
          id: authorizationId,
          tenantId,
          approvalRequestId: await approvalRequestRow(tx, {
            tenantId,
            raisedById: accountId,
          }),
          amount: '40000.00',
          createdAt: new Date(),
        },
      });
    });
    app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
  }, 120_000);

  afterAll(async () => {
    await app.end();
    await h.close();
  });

  async function asApp(...statements: string[]) {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      let last;
      for (const sql of statements) last = await app.query(sql);
      await app.query('SET CONSTRAINTS ALL IMMEDIATE');
      return last;
    } finally {
      await app.query('ROLLBACK');
    }
  }
  const privileges = async (table: string) => {
    const { rows } = await app.query<Record<string, boolean>>(
      `SELECT has_table_privilege($1, 'SELECT') AS select,
              has_table_privilege($1, 'INSERT') AS insert,
              has_table_privilege($1, 'UPDATE') AS update,
              has_table_privilege($1, 'DELETE') AS delete,
              has_table_privilege($1, 'TRUNCATE') AS truncate`,
      [table],
    );
    return rows[0];
  };
  /**
   * The submitted state, as the raise writes it. Its request is a made-up
   * id: the foreign key is deferred, and each case fails on its own error
   * before the commit's checks.
   */
  const submitted = (id: string) =>
    `UPDATE finance_budgets SET status = 'submitted', submitted_at = now(),
       approval_request_id = gen_random_uuid() WHERE id = '${id}'`;

  it('the app writes what each table needs and nothing more; nothing is truncated', async () => {
    const append = { select: true, insert: true, update: false, delete: false };
    const expected: Record<string, Record<string, boolean>> = {
      finance_budgets: {
        select: true,
        insert: true,
        update: true,
        delete: false,
      },
      // A draft's lines are replaced: deleted, while a draft only (trigger).
      finance_budget_lines: {
        select: true,
        insert: true,
        update: true,
        delete: true,
      },
      finance_budget_adjustments: append,
      // Locked by an expense (FOR UPDATE needs UPDATE); never changed (trigger).
      finance_expense_authorizations: {
        select: true,
        insert: true,
        update: true,
        delete: false,
      },
      finance_expenses: {
        select: true,
        insert: true,
        update: true,
        delete: false,
      },
    };
    for (const [table, p] of Object.entries(expected))
      expect({ table, ...(await privileges(table)) }).toEqual({
        table,
        ...p,
        truncate: false,
      });
  });

  it('a draft’s lines change; a submitted budget’s never', async () => {
    await asApp(
      `UPDATE finance_budget_lines SET amount = 5 WHERE id = '${draftLineId}'`,
      `DELETE FROM finance_budget_lines WHERE id = '${draftLineId}'`,
    );
    for (const sql of [
      `UPDATE finance_budget_lines SET amount = 5 WHERE id = '${draftLineId}'`,
      `DELETE FROM finance_budget_lines WHERE id = '${draftLineId}'`,
      `INSERT INTO finance_budget_lines (id, tenant_id, budget_id, category, amount)
         VALUES (gen_random_uuid(), '${tenantId}', '${draftId}', 'other', 1)`,
    ])
      await expect(asApp(submitted(draftId), sql)).rejects.toThrow(
        /change only while it is a draft/,
      );
  });

  it('a budget keeps its year and moves forward once', async () => {
    await expect(
      asApp(
        `UPDATE finance_budgets SET fiscal_year = 2099 WHERE id = '${draftId}'`,
      ),
    ).rejects.toThrow(/keeps its year/);
    await expect(
      asApp(
        `UPDATE finance_budgets SET status = 'active', decided_at = now() WHERE id = '${draftId}'`,
      ),
    ).rejects.toThrow(/moves forward once|state_shape/);
    await expect(
      asApp(
        submitted(draftId),
        `UPDATE finance_budgets SET status = 'rejected', decided_at = now() WHERE id = '${draftId}'`,
        `UPDATE finance_budgets SET status = 'active' WHERE id = '${draftId}'`,
      ),
    ).rejects.toThrow(/moves forward once/);
    await expect(
      asApp(`DELETE FROM finance_budgets WHERE id = '${draftId}'`),
    ).rejects.toThrow(/permission denied/);
  });

  it('one active budget per year', async () => {
    await expect(
      asApp(
        submitted(activeId),
        `UPDATE finance_budgets SET status = 'active', decided_at = now() WHERE id = '${activeId}'`,
        `INSERT INTO finance_budgets (id, tenant_id, fiscal_year, starts_on, ends_on, status,
            approval_request_id, created_by_account_id, created_at, submitted_at, decided_at)
          SELECT gen_random_uuid(), tenant_id, fiscal_year, starts_on, ends_on, 'active',
            gen_random_uuid(), created_by_account_id, now(), now(), now()
            FROM finance_budgets WHERE id = '${activeId}'`,
      ),
    ).rejects.toThrow(/finance_budgets_one_active/);
  });

  it('a fiscal year is a year from the first of a month', async () => {
    await expect(
      asApp(
        `INSERT INTO finance_budgets (id, tenant_id, fiscal_year, starts_on, ends_on, created_by_account_id, created_at)
           VALUES (gen_random_uuid(), '${tenantId}', 2091, '2091-01-02', '2092-01-01', '${accountId}', now())`,
      ),
    ).rejects.toThrow(/finance_budgets_period/);
  });

  it('an authorization is locked by an expense, and never changed or deleted', async () => {
    await expect(
      asApp(
        `SELECT id FROM finance_expense_authorizations WHERE id = '${authorizationId}' FOR UPDATE`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      asApp(
        `UPDATE finance_expense_authorizations SET amount = 1 WHERE id = '${authorizationId}'`,
      ),
    ).rejects.toThrow(/append-only|immutable/);
    await expect(
      asApp(
        `DELETE FROM finance_expense_authorizations WHERE id = '${authorizationId}'`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('an expense keeps its terms and is voided once', async () => {
    await expect(
      asApp(`UPDATE finance_expenses SET amount = 1 WHERE id = '${expenseId}'`),
    ).rejects.toThrow(/keeps its terms/);
    await expect(
      asApp(
        `UPDATE finance_expenses SET voided_at = now(), voided_by_account_id = '${accountId}',
           void_reason_code = 'duplicate' WHERE id = '${expenseId}'`,
        `UPDATE finance_expenses SET void_reason_code = 'other' WHERE id = '${expenseId}'`,
      ),
    ).rejects.toThrow(/voided once/);
    await expect(
      asApp(`DELETE FROM finance_expenses WHERE id = '${expenseId}'`),
    ).rejects.toThrow(/permission denied/);
  });

  it('the counters take expenses', async () => {
    await asApp(
      `INSERT INTO finance_counters (tenant_id, kind, last_number) VALUES ('${tenantId}', 'expense', 1)
         ON CONFLICT (tenant_id, kind) DO NOTHING`,
    );
  });
});
