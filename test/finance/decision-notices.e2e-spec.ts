import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * The unit is told of a credit note and of a compensation (ADR 0058): codes
 * only, never an amount; a compensation is a credit note with the reason
 * `compensation` and why, from a closed list.
 */
describe('Finance — credit notes and compensations told', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Decision Notices');
  });

  afterAll(() => h.close());

  const credit = (invoiceId: string, body: object) =>
    f.http(
      'post',
      `/staff/invoices/${invoiceId}/credit-notes`,
      s.manager.token,
      body,
    );
  const told = (invoiceId: string) =>
    f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.notification.findMany({
          where: { targetId: invoiceId },
          orderBy: { createdAt: 'asc' },
        }),
      ),
    );
  const fields = (r: { body: unknown }) =>
    (r.body as { fields: { field: string; code: string }[] }).fields;

  it('a credit note tells the unit its reason', async () => {
    const { invoiceId } = await f.issue(s.manager, s.home.id);
    const res = await credit(invoiceId, {
      amount: '50',
      reasonCode: 'goodwill',
    }).expect(201);
    expect(res.body).toMatchObject({
      reasonCode: 'goodwill',
      compensationReason: null,
    });
    const notes = (await told(invoiceId)).filter(
      (n) => n.kind === 'credit_note.issued',
    );
    expect(notes.map((n) => n.accountId)).toEqual([s.owner.id]);
    expect(notes[0].params).toEqual({ reason: 'goodwill' });
    expect(notes[0].targetType).toBe('invoice');
  });

  it('a compensation says why, and is told as a compensation', async () => {
    const { invoiceId } = await f.issue(s.manager, s.home.id);
    expect(
      fields(
        await credit(invoiceId, {
          amount: '50',
          reasonCode: 'compensation',
        }).expect(400),
      ),
    ).toEqual([{ field: 'compensationReasonCode', code: 'FIELD_REQUIRED' }]);
    expect(
      fields(
        await credit(invoiceId, {
          amount: '50',
          reasonCode: 'compensation',
          compensationReasonCode: 'bored',
        }).expect(400),
      ),
    ).toMatchObject([
      { field: 'compensationReasonCode', code: 'INVALID_REASON_CODE' },
    ]);
    expect(
      fields(
        await credit(invoiceId, {
          amount: '50',
          reasonCode: 'waiver',
          compensationReasonCode: 'service_outage',
        }).expect(400),
      ),
    ).toEqual([{ field: 'compensationReasonCode', code: 'FIELD_NOT_ALLOWED' }]);

    const res = await credit(invoiceId, {
      amount: '75',
      reasonCode: 'compensation',
      compensationReasonCode: 'service_outage',
    }).expect(201);
    expect(res.body).toMatchObject({
      reasonCode: 'compensation',
      compensationReason: 'service_outage',
    });
    const kinds = (await told(invoiceId)).map((n) => [n.kind, n.params]);
    expect(kinds).toContainEqual([
      'compensation.granted',
      { reason: 'service_outage' },
    ]);
    expect(kinds.map(([k]) => k)).not.toContain('credit_note.issued');
    // The invoice's own view lists it with its reason.
    const detail = (
      await f.http('get', `/invoices/${invoiceId}`, s.owner.token).expect(200)
    ).body as { creditNotes: { compensationReason: string | null }[] };
    expect(detail.creditNotes.map((n) => n.compensationReason)).toEqual([
      'service_outage',
    ]);
  });

  it('a compensation reason exists exactly on a compensation (the database)', async () => {
    const { invoiceId } = await f.issue(s.manager, s.home.id);
    const id = (
      (
        await credit(invoiceId, { amount: '10', reasonCode: 'other' }).expect(
          201,
        )
      ).body as { id: string }
    ).id;
    // Credit notes never change (ADR 0046), so the CHECK is met at insert.
    await expect(
      f.x.asManager(s.c, () =>
        h.moduleRef.get(TenantTx).withTenantTx((tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO credit_notes (id, tenant_id, number, invoice_id, amount, reason_code, created_by_account_id, compensation_reason)
             SELECT gen_random_uuid(), tenant_id, number + 100000, invoice_id, 1, 'waiver', created_by_account_id, 'other'
               FROM credit_notes WHERE id = $1`,
            id,
          ),
        ),
      ),
    ).rejects.toThrow(/credit_notes_compensation/);
  });
});
