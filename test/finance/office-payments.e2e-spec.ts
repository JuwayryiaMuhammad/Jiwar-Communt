import { Prisma } from '@prisma/client';
import type { Response } from 'supertest';
import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { FinanceAccess } from '../../src/finance/access';
import { PaymentsService } from '../../src/finance/payments/payments.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { receiptCodeHash } from '../../src/finance/payments/receipts';
import { day } from '../setup/facilities';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const body = <T>(res: Response) => res.body as T;
const code = (res: Response) => body<{ code: string }>(res).code;

interface PaymentBody {
  id: string;
  channel: string;
  method: string;
  amount: string;
  receiptNumber: string;
  receiptCode: string;
  receiptUrl: string;
  allocated: string;
  unallocated: string;
  reversal: { reasonCode: string } | null;
  recordedBy: { id: string; fullName: string | null } | null;
  allocations: { invoiceId: string; amount: string }[];
}

interface Statement {
  outstanding: string;
  credit: string;
  openInvoices: { id: string; outstanding: string }[];
  entries: { kind: string; number: string; amount: string }[];
  onlinePayment: boolean;
}

/**
 * Payments at the office (ADR 0046): at most what is owed, the invoices
 * named first then the oldest due, a receipt each; reversed once by a new
 * row; idempotent.
 */
describe('Finance — office payments', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Office Court');
  });

  afterAll(() => h.close());

  const pay = (
    c: FinanceSetUp,
    over: Record<string, unknown> = {},
    token = c.accountant.token,
  ) =>
    f.http('post', `/staff/units/${c.home.id}/payments`, token, {
      amount: '500',
      method: 'cash',
      paidOn: day(0),
      ...over,
    });
  const invoice = async (c: FinanceSetUp, id: string) =>
    body<{ outstanding: string; paid: string; status: string }>(
      await f.http('get', `/staff/invoices/${id}`, c.manager.token).expect(200),
    );
  /** Money the unit paid beyond what it owed, written as the webhook would. */
  const credit = (c: FinanceSetUp, amount: string) =>
    f.x.asManager(c.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
        await h.moduleRef.get(FinanceAccess).lockUnits(tx, [c.home.id]);
        await h.moduleRef.get(PaymentsService).create(tx, newId(), {
          unitId: c.home.id,
          channel: 'office',
          method: 'cash',
          amount: new Prisma.Decimal(amount),
          paidOn: day(0),
          reference: null,
          recordedById: c.manager.id,
          named: [],
        });
      }),
    );
  const statement = async (c: FinanceSetUp) =>
    body<Statement>(
      await f
        .http('get', `/units/${c.home.id}/statement`, c.owner.token)
        .expect(200),
    );

  it('pays the oldest due first, with a receipt; the unit is told', async () => {
    const c = await f.setUp('Office Oldest');
    const later = await f.issue(c.manager, c.home.id, { dueOn: day(20) });
    const sooner = await f.issue(c.manager, c.home.id, { dueOn: day(5) });
    const res = await pay(c, { amount: '1200' }).expect(201);
    const p = body<PaymentBody>(res);
    expect(p).toMatchObject({
      channel: 'office',
      method: 'cash',
      amount: '1200.00',
      allocated: '1200.00',
      unallocated: '0.00',
      reversal: null,
      recordedBy: { id: c.accountant.id },
    });
    expect(p.receiptNumber).toMatch(/^RC-\d{6}$/);
    expect(p.receiptCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(p.receiptUrl).toBe(
      `https://app.jiwar.test/receipt#${p.receiptCode}`,
    );
    expect(p.allocations).toEqual([
      expect.objectContaining({
        invoiceId: sooner.invoiceId,
        amount: '1000.00',
      }),
      expect.objectContaining({ invoiceId: later.invoiceId, amount: '200.00' }),
    ]);
    expect(await invoice(c, sooner.invoiceId)).toMatchObject({
      status: 'paid',
      outstanding: '0.00',
    });
    expect(await invoice(c, later.invoiceId)).toMatchObject({
      status: 'partially_paid',
      outstanding: '800.00',
    });
    // The pointer holds the code's hash only.
    const link = await h.moduleRef.get(GlobalDbService).receiptLink.findUnique({
      where: { codeHash: receiptCodeHash(p.receiptCode) },
    });
    expect(link).toMatchObject({ tenantId: c.c.tenantId, paymentId: p.id });
    expect(
      (await f.notifications(c.c, c.owner.id, 'payment.received')).map(
        (n) => n.targetId,
      ),
    ).toEqual([p.id]);
    // Residents see it without who recorded it.
    const mine = body<PaymentBody>(
      await f.http('get', `/payments/${p.id}`, c.owner.token).expect(200),
    );
    expect(mine.recordedBy).toBeNull();
    expect(mine.receiptCode).toBe(p.receiptCode);
  });

  it('pays the invoices it names, and only those: at most what they still ask for', async () => {
    const c = await f.setUp('Office Named');
    const old = await f.issue(c.manager, c.home.id, { dueOn: day(1) });
    const named = await f.issue(c.manager, c.home.id, { dueOn: day(30) });
    const over = await pay(c, {
      amount: '1500',
      invoiceIds: [named.invoiceId],
    }).expect(409);
    expect(body<{ params: object }>(over).params).toEqual({
      outstanding: '1000.00',
    });
    const p = body<PaymentBody>(
      await pay(c, { amount: '1000', invoiceIds: [named.invoiceId] }).expect(
        201,
      ),
    );
    expect(p.allocations.map((a) => [a.invoiceId, a.amount])).toEqual([
      [named.invoiceId, '1000.00'],
    ]);
    expect((await invoice(c, old.invoiceId)).status).toBe('unpaid');
  });

  it('never more than is owed; a named invoice must be the unit’s and owed', async () => {
    const c = await f.setUp('Office Limits');
    const { invoiceId } = await f.issue(c.manager, c.home.id);
    const over = await pay(c, { amount: '1000.01' }).expect(409);
    expect(code(over)).toBe('PAYMENT_EXCEEDS_OUTSTANDING');
    expect(body<{ params: object }>(over).params).toEqual({
      outstanding: '1000.00',
    });
    const elsewhere = await f.issue(s.manager, s.home.id);
    const foreign = await pay(c, { invoiceIds: [elsewhere.invoiceId] }).expect(
      409,
    );
    expect(code(foreign)).toBe('INVOICE_NOT_PAYABLE');
    await pay(c, { amount: '1000' }).expect(201);
    expect(code(await pay(c, { amount: '1' }).expect(409))).toBe(
      'PAYMENT_EXCEEDS_OUTSTANDING',
    );
    expect(code(await pay(c, { invoiceIds: [invoiceId] }).expect(409))).toBe(
      'INVOICE_NOT_PAYABLE',
    );
  });

  it('a transfer or cheque carries its reference, cash none; the day is today or up to 31 days ago', async () => {
    const c = await f.setUp('Office Fields');
    await f.issue(c.manager, c.home.id);
    const fields = async (over: Record<string, unknown>) =>
      body<{ fields: unknown[] }>(await pay(c, over).expect(400)).fields;
    expect(await fields({ method: 'cheque' })).toEqual([
      { field: 'reference', code: 'FIELD_REQUIRED' },
    ]);
    expect(await fields({ reference: 'TX-1' })).toEqual([
      { field: 'reference', code: 'FIELD_NOT_ALLOWED' },
    ]);
    expect(await fields({ paidOn: day(1) })).toEqual([
      {
        field: 'paidOn',
        code: 'PAID_ON_OUT_OF_RANGE',
        params: { min: day(-31), max: day(0) },
      },
    ]);
    const p = body<PaymentBody & { reference: string }>(
      await pay(c, {
        method: 'bank_transfer',
        reference: 'NBE/2026-551',
        paidOn: day(-31),
      }).expect(201),
    );
    expect(p.reference).toBe('NBE/2026-551');
  });

  it('an Idempotency-Key records once', async () => {
    const c = await f.setUp('Office Idem');
    await f.issue(c.manager, c.home.id);
    const key = `pay-${Date.now()}`;
    const a = await pay(c).set('Idempotency-Key', key).expect(201);
    const b = await pay(c).set('Idempotency-Key', key).expect(201);
    expect(body<PaymentBody>(b).id).toBe(body<PaymentBody>(a).id);
    expect((await statement(c)).outstanding).toBe('500.00');
  });

  describe('reversal', () => {
    it('once, with a reason code; what it paid is owed again, and other credit covers it', async () => {
      const c = await f.setUp('Office Reverse');
      const first = await f.issue(c.manager, c.home.id);
      const p = body<PaymentBody>(await pay(c, { amount: '1000' }).expect(201));
      expect((await invoice(c, first.invoiceId)).status).toBe('paid');
      const reverse = (id: string, reasonCode = 'bounced_cheque') =>
        f.http('post', `/staff/payments/${id}/reverse`, c.accountant.token, {
          reasonCode,
        });
      const res = await reverse(p.id).expect(201);
      expect(body<PaymentBody>(res)).toMatchObject({
        id: p.id,
        allocated: '0.00',
        unallocated: '0.00',
        reversal: { reasonCode: 'bounced_cheque' },
      });
      expect(await invoice(c, first.invoiceId)).toMatchObject({
        status: 'unpaid',
        outstanding: '1000.00',
      });
      expect(code(await reverse(p.id).expect(409))).toBe(
        'PAYMENT_ALREADY_REVERSED',
      );
      expect(
        body<{ fields: { code: string }[] }>(
          await reverse(p.id, 'oops').expect(400),
        ).fields.map((x) => x.code),
      ).toEqual(['INVALID_REASON_CODE']);
      const st = await statement(c);
      expect(st.entries.map((e) => e.kind)).toEqual([
        'reversal',
        'payment',
        'invoice',
      ]);
      expect(st.entries[0].number).toBe(p.receiptNumber);
    });

    it('a reversal frees invoices that the unit’s credit then pays', async () => {
      const c = await f.setUp('Office Credit');
      const a = await f.issue(c.manager, c.home.id, { dueOn: day(1) });
      const pa = body<PaymentBody>(
        await pay(c, { amount: '1000' }).expect(201),
      );
      // Money beyond what is owed (as a late online payment would bring).
      await credit(c, '400');
      expect((await statement(c)).credit).toBe('400.00');
      await f
        .http('post', `/staff/payments/${pa.id}/reverse`, c.accountant.token, {
          reasonCode: 'entered_in_error',
        })
        .expect(201);
      expect(await invoice(c, a.invoiceId)).toMatchObject({
        outstanding: '600.00',
        paid: '400.00',
        status: 'partially_paid',
      });
      expect(await statement(c)).toMatchObject({
        outstanding: '600.00',
        credit: '0.00',
      });
    });

    it('a unit’s credit pays its next invoice at once', async () => {
      const c = await f.setUp('Office Next');
      await credit(c, '1500');
      const next = await f.issue(c.manager, c.home.id);
      expect(await invoice(c, next.invoiceId)).toMatchObject({
        status: 'paid',
        outstanding: '0.00',
      });
      const after = await f.issue(c.manager, c.home.id);
      expect(await invoice(c, after.invoiceId)).toMatchObject({
        status: 'partially_paid',
        outstanding: '500.00',
      });
      expect((await statement(c)).credit).toBe('0.00');
    });

    it('staff and residents only: a guard neither records nor reverses', async () => {
      const guard = await f.staff(s.c, []);
      await pay(s, {}, guard.token).expect(403);
      await f.http('get', '/staff/payments', guard.token).expect(403);
    });
  });

  it('who sees a unit’s payments: whoever sees its money', async () => {
    const c = await f.setUp('Office Who');
    await f.issue(c.manager, c.home.id);
    const p = body<PaymentBody>(await pay(c).expect(201));
    const member = await f.family(c.c, c.home.id, c.owner);
    expect(
      code(
        await f
          .http('get', `/units/${c.home.id}/payments`, member.token)
          .expect(403),
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(await f.http('get', `/payments/${p.id}`, member.token).expect(404)),
    ).toBe('PAYMENT_NOT_FOUND');
    await f.grantFinance(c.c, c.owner, member.memberId);
    await f
      .http('get', `/units/${c.home.id}/payments`, member.token)
      .expect(200);
    await f.http('get', `/payments/${p.id}`, member.token).expect(200);
    const st = await statement(c);
    expect(st).toMatchObject({
      outstanding: '500.00',
      credit: '0.00',
      onlinePayment: false,
    });
  });
});
