import { day } from '../setup/facilities';
import { financeHelpers } from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * The public receipt page (ADR 0046): whoever holds a receipt's link sees
 * the compound, its number, the amount, the day and whether it stands —
 * no name, no unit; anything else is one "not found".
 */
describe('Finance — public receipts', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  const lookup = (code: unknown) =>
    h.http().post(`${API}/public/receipts/lookup`).send({ code });

  it('a receipt reads as valid, then reversed; only its public facts', async () => {
    const s = await f.setUp('Receipts Court');
    await f.issue(s.manager, s.home.id);
    const paid = await f
      .http('post', `/staff/units/${s.home.id}/payments`, s.accountant.token, {
        amount: '400',
        method: 'cheque',
        reference: 'CHQ-1',
        paidOn: day(0),
      })
      .expect(201);
    const p = paid.body as {
      id: string;
      receiptCode: string;
      receiptNumber: string;
    };
    const res = await lookup(p.receiptCode).expect(200);
    expect(res.body).toEqual({
      compoundName: expect.stringContaining('Receipts Court') as unknown,
      receiptNumber: p.receiptNumber,
      amount: '400.00',
      currency: 'EGP',
      paidOn: day(0),
      status: 'valid',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.text).not.toContain(s.home.code);
    expect(res.text).not.toContain('CHQ-1');
    await f
      .http('post', `/staff/payments/${p.id}/reverse`, s.manager.token, {
        reasonCode: 'bounced_cheque',
      })
      .expect(201);
    expect((await lookup(p.receiptCode).expect(200)).body).toMatchObject({
      status: 'reversed',
    });
  });

  it('an unknown or malformed code is one answer: not found', async () => {
    for (const code of ['A'.repeat(22), 'short', 'x'.repeat(23), '../../etc']) {
      const res = await lookup(code).expect(404);
      expect((res.body as { code: string }).code).toBe('RECEIPT_NOT_FOUND');
    }
    await lookup('').expect(400);
  });
});
