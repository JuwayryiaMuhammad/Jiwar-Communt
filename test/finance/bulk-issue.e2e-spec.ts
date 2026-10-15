import type { Response } from 'supertest';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { day } from '../setup/facilities';
import { financeHelpers } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const body = <T>(res: Response) => res.body as T;

/**
 * Issuing at the same time (ADR 0046): one Idempotency-Key is one batch
 * however many times it arrives; two issues at once take disjoint,
 * gapless numbers; two credit notes at once never take more than is owed.
 */
describe('Finance — bulk issue (races)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
  });

  afterAll(() => h.close());

  const all = (token: string, amount = '100') =>
    f.http('post', '/staff/invoices', token, {
      target: 'all',
      kind: 'service_charge',
      dueOn: day(10),
      lines: [{ descriptionEn: 'Fee', descriptionAr: 'رسم', amount }],
    });

  it('the same key four times at once: one batch, one invoice per unit', async () => {
    const s = await f.setUp('Bulk Same Key');
    for (let i = 0; i < 9; i++) await f.unit(s.c, 'A');
    const key = `bulk-${Date.now()}`;
    const answers = await Promise.all(
      [0, 1, 2, 3].map(() => all(s.manager.token).set('Idempotency-Key', key)),
    );
    expect(answers.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const ids = new Set(answers.map((r) => body<{ id: string }>(r).id));
    expect(ids.size).toBe(1);
    const count = await f.x.asManager(s.c, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) =>
          tx.invoice.count({ where: { batchId: [...ids][0] } }),
        ),
    );
    expect(count).toBe(10);
  });

  it('two issues to every unit at once: each unit gets both, numbers disjoint and gapless', async () => {
    const s = await f.setUp('Bulk Two At Once');
    for (let i = 0; i < 7; i++) await f.unit(s.c, 'A');
    const [a, b] = await Promise.all([
      all(s.manager.token, '100'),
      all(s.accountant.token, '200'),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const numbers = await f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        tx.invoice.findMany({
          where: {
            batchId: {
              in: [body<{ id: string }>(a).id, body<{ id: string }>(b).id],
            },
          },
          select: { number: true, unitId: true, batchId: true },
        }),
      ),
    );
    expect(numbers).toHaveLength(16);
    const sorted = numbers.map((n) => n.number).sort((x, y) => x - y);
    expect(sorted[15] - sorted[0]).toBe(15);
    expect(new Set(sorted).size).toBe(16);
    // One batch's numbers are one run: the exclusive compound lock.
    for (const batch of [a, b]) {
      const mine = numbers
        .filter((n) => n.batchId === body<{ id: string }>(batch).id)
        .map((n) => n.number)
        .sort((x, y) => x - y);
      expect(mine[7] - mine[0]).toBe(7);
    }
  });

  it('a single-unit issue and a compound-wide issue at once both land', async () => {
    const s = await f.setUp('Bulk Mixed');
    for (let i = 0; i < 4; i++) await f.unit(s.c, 'A');
    const [one, every] = await Promise.all([
      f.http('post', '/staff/invoices', s.manager.token, {
        target: 'unit',
        unitId: s.home.id,
        kind: 'other',
        dueOn: day(3),
        lines: [{ descriptionEn: 'Key', descriptionAr: 'مفتاح', amount: '50' }],
      }),
      all(s.accountant.token),
    ]);
    expect([one.status, every.status]).toEqual([201, 201]);
  });

  it('two credit notes at once on one invoice: never more than is owed', async () => {
    const s = await f.setUp('Bulk Credits');
    const { invoiceId } = await f.issue(s.manager, s.home.id);
    const credit = (token: string) =>
      f.http('post', `/staff/invoices/${invoiceId}/credit-notes`, token, {
        amount: '600',
        reasonCode: 'waiver',
      });
    const answers = await Promise.all([
      credit(s.manager.token),
      credit(s.accountant.token),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([201, 409]);
    const detail = await f
      .http('get', `/staff/invoices/${invoiceId}`, s.manager.token)
      .expect(200);
    expect(body<{ outstanding: string }>(detail).outstanding).toBe('400.00');
  });
});
