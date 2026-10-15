import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  allocationRow,
  batchRow,
  creditNoteRow,
  eventRow,
  instalmentPlanRow,
  invoiceRow,
  lineRow,
  noticeRow,
  paymentRow,
  planRow,
  sessionInvoiceRow,
  sessionRow,
} from '../setup/finance-rows';
import { required } from '../setup/test-env';

/**
 * The finance tables (ADR 0046) at the database: what the app may write,
 * which tables are append-only even for their owner, and what the
 * triggers and the commit-time checks hold whatever the services do.
 */
describe('Finance tables — privileges, append-only rows, triggers and bounds', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let accountId: string;
  let unitId: string;
  const ids: Record<string, string> = {};

  const inTenant = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Finance schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    unitId = (await createUnit(h, tenantId)).id;
    await inTenant(async (tx) => {
      ids.batch = await batchRow(tx, {
        tenantId,
        unitId,
        createdById: accountId,
      });
      ids.invoice = await invoiceRow(tx, {
        tenantId,
        unitId,
        batchId: ids.batch,
        createdById: accountId,
      });
      ids.line = (
        await tx.invoiceLine.findFirstOrThrow({
          where: { invoiceId: ids.invoice },
        })
      ).id;
      ids.creditNote = await creditNoteRow(tx, {
        tenantId,
        invoiceId: ids.invoice,
        createdById: accountId,
      });
      ids.notice = await noticeRow(tx, { tenantId, invoiceId: ids.invoice });
      ids.plan = await planRow(tx, { tenantId, createdById: accountId });
      ids.payment = await paymentRow(tx, {
        tenantId,
        unitId,
        recordedById: accountId,
      });
      ids.allocation = await allocationRow(tx, {
        tenantId,
        paymentId: ids.payment,
        invoiceId: ids.invoice,
      });
      ids.session = await sessionRow(tx, { tenantId, unitId, accountId });
      ids.sessionInvoice = await sessionInvoiceRow(tx, {
        tenantId,
        sessionId: ids.session,
        invoiceId: ids.invoice,
      });
      ids.event = await eventRow(tx, { tenantId, sessionId: ids.session });
      ids.instalmentPlan = await instalmentPlanRow(tx, {
        tenantId,
        unitId,
        invoiceId: ids.invoice,
        createdById: accountId,
      });
      ids.remainder = await invoiceRow(tx, {
        tenantId,
        unitId,
        batchId: await batchRow(tx, {
          tenantId,
          unitId,
          createdById: accountId,
        }),
        createdById: accountId,
      });
    });
    app = new Client({ connectionString: process.env.DATABASE_URL });
    migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await app.connect();
    await migrator.connect();
  }, 120_000);

  afterAll(async () => {
    await app.end();
    await migrator.end();
    await h.close();
  });

  async function attempt(client: Client, ...statements: string[]) {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      for (const sql of statements) await client.query(sql);
      // Deferred checks run here.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    } finally {
      await client.query('ROLLBACK');
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

  it('the app updates only settings, gateways, counters, plans, overrides, sessions and instalment plans; deletes only overrides', async () => {
    const updatable: string[] = [];
    const deletable: string[] = [];
    for (const table of [
      'finance_settings',
      'finance_gateways',
      'finance_counters',
      'invoice_batches',
      'invoices',
      'invoice_lines',
      'credit_notes',
      'invoice_notices',
      'billing_plans',
      'billing_plan_overrides',
      'finance_payments',
      'finance_allocations',
      'payment_sessions',
      'payment_session_invoices',
      'payment_gateway_events',
      'receipt_links',
      'instalment_plans',
    ]) {
      const p = await privileges(table);
      expect({
        table,
        select: p.select,
        insert: p.insert,
        truncate: p.truncate,
      }).toEqual({
        table,
        select: true,
        insert: true,
        truncate: false,
      });
      if (p.update) updatable.push(table);
      if (p.delete) deletable.push(table);
    }
    expect(updatable).toEqual([
      'finance_settings',
      'finance_gateways',
      'finance_counters',
      'billing_plans',
      'billing_plan_overrides',
      'payment_sessions',
      'instalment_plans',
    ]);
    expect(deletable).toEqual(['billing_plan_overrides']);
  });

  describe.each([
    ['invoice_batches', 'batch', 'unit_count = 2'],
    ['invoices', 'invoice', 'total = 1'],
    ['invoice_lines', 'line', 'amount = 1'],
    ['credit_notes', 'creditNote', 'amount = 2'],
    ['invoice_notices', 'notice', `kind = 'overdue'`],
    ['finance_payments', 'payment', 'amount = 1'],
    ['finance_allocations', 'allocation', 'amount = 2'],
    ['payment_session_invoices', 'sessionInvoice', 'amount = 1'],
    ['payment_gateway_events', 'event', `outcome = 'applied'`],
  ])('%s is append-only', (table, key, change) => {
    it('the tables’ owner cannot update, delete or truncate it either', async () => {
      await expect(
        attempt(
          migrator,
          `UPDATE ${table} SET ${change} WHERE id = '${ids[key]}'`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        attempt(migrator, `DELETE FROM ${table} WHERE id = '${ids[key]}'`),
      ).rejects.toThrow(/append-only/);
      await expect(
        attempt(migrator, `TRUNCATE ${table} CASCADE`),
      ).rejects.toThrow(/append-only|cannot truncate/);
    });
  });

  it('what a plan bills and when is fixed; its amount and names may change', async () => {
    await attempt(
      app,
      `UPDATE billing_plans SET amount = 120, name_en = 'X' WHERE id = '${ids.plan}'`,
    );
    for (const change of [
      `frequency = 'annual'`,
      `kind = 'other'`,
      `starts_on = '2099-02-01'`,
    ]) {
      await expect(
        attempt(
          app,
          `UPDATE billing_plans SET ${change} WHERE id = '${ids.plan}'`,
        ),
      ).rejects.toThrow(/fixed/);
    }
    await expect(
      attempt(migrator, `DELETE FROM billing_plans WHERE id = '${ids.plan}'`),
    ).rejects.toThrow(/fixed/);
  });

  it('a session moves only along its edges; Paymob’s fields are set once', async () => {
    const s = ids.session;
    await expect(
      attempt(
        app,
        `UPDATE payment_sessions SET status = 'succeeded' WHERE id = '${s}'`,
      ),
    ).rejects.toThrow(/not a move|check constraint/);
    await expect(
      attempt(app, `UPDATE payment_sessions SET amount = 1 WHERE id = '${s}'`),
    ).rejects.toThrow(/not a move/);
    await attempt(
      app,
      `UPDATE payment_sessions SET status = 'open', intention_id = 'pi', client_secret_enc = '\\x00', key_version = 1 WHERE id = '${s}'`,
    );
    await expect(
      attempt(
        app,
        `UPDATE payment_sessions SET status = 'open', intention_id = 'pi', client_secret_enc = '\\x00', key_version = 1 WHERE id = '${s}'`,
        `UPDATE payment_sessions SET intention_id = 'other' WHERE id = '${s}'`,
      ),
    ).rejects.toThrow(/not a move/);
    await expect(
      attempt(
        app,
        `UPDATE payment_sessions SET status = 'failed', resolved_at = now() WHERE id = '${s}'`,
        `UPDATE payment_sessions SET status = 'open', resolved_at = NULL WHERE id = '${s}'`,
      ),
    ).rejects.toThrow(/not a move/);
    await expect(
      attempt(migrator, `DELETE FROM payment_sessions WHERE id = '${s}'`),
    ).rejects.toThrow(/not a move/);
  });

  it('an instalment plan changes once, by its cancellation; never its terms (ADR 0048)', async () => {
    const p = ids.instalmentPlan;
    const cancel = `cancelled_at = now(), cancelled_by_account_id = '${accountId}', remainder_invoice_id = '${ids.remainder}'`;
    await expect(
      attempt(app, `UPDATE instalment_plans SET total = 1 WHERE id = '${p}'`),
    ).rejects.toThrow(/only a cancellation/);
    await expect(
      attempt(
        app,
        `UPDATE instalment_plans SET cancelled_at = now() WHERE id = '${p}'`,
      ),
    ).rejects.toThrow(/instalment_plans_cancel_shape/);
    await attempt(
      app,
      `UPDATE instalment_plans SET ${cancel} WHERE id = '${p}'`,
    );
    await expect(
      attempt(
        app,
        `UPDATE instalment_plans SET ${cancel} WHERE id = '${p}'`,
        `UPDATE instalment_plans SET ${cancel} WHERE id = '${p}'`,
      ),
    ).rejects.toThrow(/only a cancellation/);
    await expect(
      attempt(migrator, `DELETE FROM instalment_plans WHERE id = '${p}'`),
    ).rejects.toThrow(/only a cancellation/);
    await expect(
      attempt(migrator, `TRUNCATE instalment_plans CASCADE`),
    ).rejects.toThrow(/append-only|cannot truncate/);
  });

  it('an instalment names its plan and place; it may fall due two years out, any other invoice one (ADR 0048)', async () => {
    const insert = (over: string) =>
      `INSERT INTO invoices (id, tenant_id, number, batch_id, unit_id, kind, total, currency, issued_on, due_on, instalment_plan_id, instalment_position)
       VALUES (gen_random_uuid(), '${tenantId}', 990000 + floor(random() * 9999)::int, '${ids.batch}', '${unitId}', 'other', 1, 'EGP', current_date, ${over})`;
    await expect(
      attempt(app, insert(`current_date + 700, NULL, NULL`)),
    ).rejects.toThrow(/invoices_due/);
    await expect(
      attempt(app, insert(`current_date, '${ids.instalmentPlan}', NULL`)),
    ).rejects.toThrow(/invoices_instalment_shape/);
    await expect(
      attempt(app, insert(`current_date + 731, '${ids.instalmentPlan}', 1`)),
    ).rejects.toThrow(/invoices_due/);
  });

  it('a credit note of reason instalment_plan names its plan, and only such a note does', async () => {
    const note = (reason: string, plan: string) =>
      `INSERT INTO credit_notes (id, tenant_id, number, invoice_id, amount, reason_code, created_by_account_id, instalment_plan_id)
       VALUES (gen_random_uuid(), '${tenantId}', 990000 + floor(random() * 9999)::int, '${ids.remainder}', 1, '${reason}', '${accountId}', ${plan})`;
    await expect(attempt(app, note('instalment_plan', 'NULL'))).rejects.toThrow(
      /credit_notes_instalment_plan_link/,
    );
    await expect(
      attempt(app, note('waiver', `'${ids.instalmentPlan}'`)),
    ).rejects.toThrow(/credit_notes_instalment_plan_link/);
  });

  describe('at commit', () => {
    it('an invoice’s lines add up to its total', async () => {
      await expect(
        inTenant(async (tx) => {
          const id = await invoiceRow(tx, {
            tenantId,
            unitId,
            batchId: await batchRow(tx, {
              tenantId,
              unitId,
              createdById: accountId,
            }),
            createdById: accountId,
          });
          await lineRow(tx, {
            tenantId,
            invoiceId: id,
            amount: '1',
            position: 2,
          });
        }),
      ).rejects.toThrow(/do not add up/);
      // A line added later to an invoice of an earlier transaction too.
      await expect(
        inTenant((tx) =>
          lineRow(tx, {
            tenantId,
            invoiceId: ids.invoice,
            amount: '1',
            position: 3,
          }),
        ),
      ).rejects.toThrow(/do not add up/);
    });

    it('credit notes and live allocations never exceed the total; allocations never the payment', async () => {
      await expect(
        inTenant((tx) =>
          creditNoteRow(tx, {
            tenantId,
            invoiceId: ids.invoice,
            createdById: accountId,
            amount: '99',
          }),
        ),
      ).rejects.toThrow(/exceed its total/);
      await expect(
        inTenant(async (tx) => {
          const big = await invoiceRow(tx, {
            tenantId,
            unitId,
            batchId: await batchRow(tx, {
              tenantId,
              unitId,
              createdById: accountId,
            }),
            createdById: accountId,
            total: '1000',
          });
          await allocationRow(tx, {
            tenantId,
            paymentId: ids.payment,
            invoiceId: big,
            amount: '100',
          });
        }),
      ).rejects.toThrow(/exceed its amount/);
    });

    it('a reversal reverses an office payment of its own unit only', async () => {
      await expect(
        attempt(
          app,
          `INSERT INTO finance_payments (id, tenant_id, kind, unit_id, reverses_id, reason_code, recorded_by_account_id)
           VALUES (gen_random_uuid(), '${tenantId}', 'reversal', '${unitId}', '${ids.allocation}', 'duplicate', '${accountId}')`,
        ),
      ).rejects.toThrow(/office payment|foreign key/);
      await attempt(
        app,
        `INSERT INTO finance_payments (id, tenant_id, kind, unit_id, reverses_id, reason_code, recorded_by_account_id)
         VALUES (gen_random_uuid(), '${tenantId}', 'reversal', '${unitId}', '${ids.payment}', 'duplicate', '${accountId}')`,
      );
    });
  });
});
