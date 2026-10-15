import type { Response } from 'supertest';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { INVOICE_NOTICES_SWEEP } from '../../src/finance/invoices/invoice-notices.sweep';
import { INVOICE_REMINDERS_SWEEP } from '../../src/finance/invoices/invoice-reminders.sweep';
import { addDays } from '../../src/core/common/slots/day-slots';
import { day } from '../setup/facilities';
import {
  backdateInvoice,
  financeHelpers,
  type FinanceSetUp,
} from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';

interface Instalment {
  id: string;
  number: string;
  position: number;
  total: string;
  paid: string;
  outstanding: string;
  status: string;
  dueOn: string;
  kind: string;
}
interface Plan {
  id: string;
  number: string;
  unitId: string;
  invoiceId: string;
  invoiceNumber: string;
  instalmentCount: number;
  total: string;
  outstanding: string;
  status: string;
  cancelledAt: string | null;
  remainderInvoiceId: string | null;
  remainderInvoiceNumber: string | null;
  instalments: Instalment[];
}
interface InvoiceDetail {
  number: string;
  kind: string;
  status: string;
  total: string;
  credited: string;
  paid: string;
  outstanding: string;
  dueOn: string;
  instalmentPlan: {
    id: string;
    number: string;
    position: number;
    count: number;
  } | null;
  rescheduledBy: { id: string; number: string } | null;
  lines: { descriptionEn: string; descriptionAr: string; amount: string }[];
  creditNotes: { amount: string; reasonCode: string }[];
}

const body = <T>(res: Response) => res.body as T;
const code = (res: Response) => body<{ code: string }>(res).code;
const params = (res: Response) =>
  body<{ params: Record<string, unknown> }>(res).params;

/**
 * Instalment plans (ADR 0048): what an open invoice owes becomes 2–24
 * ordinary invoices; a credit note of reason `instalment_plan` closes the
 * original, which reads `rescheduled`. One push tells the unit. Cancelling
 * credits what the instalments owe and asks for it again in one invoice.
 */
describe('Finance — instalment plans', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;
  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
    s = await f.setUp('Instalments Court');
  });

  afterAll(() => h.close());

  const convert = (
    invoiceId: string,
    instalments: { dueOn: string; amount: string }[],
    token = s.accountant.token,
  ) =>
    f.http('post', `/staff/invoices/${invoiceId}/instalment-plan`, token, {
      instalments,
    });
  const invoice = async (id: string, token = s.manager.token) =>
    body<InvoiceDetail>(
      await f.http('get', `/staff/invoices/${id}`, token).expect(200),
    );
  const plan = async (id: string) =>
    body<Plan>(
      await f
        .http('get', `/staff/instalment-plans/${id}`, s.manager.token)
        .expect(200),
    );
  const pay = (unitId: string, amount: string, invoiceIds?: string[]) =>
    f.http('post', `/staff/units/${unitId}/payments`, s.accountant.token, {
      amount,
      method: 'cash',
      paidOn: day(0),
      ...(invoiceIds ? { invoiceIds } : {}),
    });
  const sweep = (name: string) =>
    h.moduleRef.get(SweepRunner).run(name, new Date());

  describe('converting', () => {
    it('splits what is owed: the original reads rescheduled, the instalments are ordinary invoices, one push', async () => {
      const home = await f.unit(s.c, 'A');
      const owner = await f.owner(s.c, home.id);
      const { invoiceId } = await f.issue(s.manager, home.id, {
        kind: 'maintenance',
      });
      const res = await convert(invoiceId, [
        { dueOn: day(5), amount: '300' },
        { dueOn: day(35), amount: '300' },
        { dueOn: day(65), amount: '400' },
      ]).expect(201);
      const p = body<Plan>(res);
      const original = await invoice(invoiceId);
      expect(p).toMatchObject({
        number: expect.stringMatching(/^IP-\d{6}$/) as string,
        unitId: home.id,
        invoiceId,
        invoiceNumber: original.number,
        instalmentCount: 3,
        total: '1000.00',
        outstanding: '1000.00',
        status: 'active',
        cancelledAt: null,
        remainderInvoiceId: null,
      });
      expect(
        p.instalments.map((i) => [i.position, i.total, i.dueOn, i.status]),
      ).toEqual([
        [1, '300.00', day(5), 'unpaid'],
        [2, '300.00', day(35), 'unpaid'],
        [3, '400.00', day(65), 'unpaid'],
      ]);
      // Consecutive numbers after the plan's own credit note.
      const numbers = p.instalments.map((i) => Number(i.number.slice(4)));
      expect(numbers).toEqual([numbers[0], numbers[0] + 1, numbers[0] + 2]);
      expect(original).toMatchObject({
        status: 'rescheduled',
        credited: '1000.00',
        outstanding: '0.00',
        rescheduledBy: { id: p.id, number: p.number },
        instalmentPlan: null,
        creditNotes: [{ amount: '1000.00', reasonCode: 'instalment_plan' }],
      });
      const second = await invoice(p.instalments[1].id);
      expect(second).toMatchObject({
        kind: 'maintenance',
        instalmentPlan: { id: p.id, number: p.number, position: 2, count: 3 },
        rescheduledBy: null,
        lines: [
          {
            descriptionEn: `Instalment 2 of 3 — ${original.number}`,
            descriptionAr: `القسط 2 من 3 — ${original.number}`,
            amount: '300.00',
          },
        ],
      });
      // One push for the plan; the instalments are never announced one by one.
      await sweep(INVOICE_NOTICES_SWEEP);
      expect(
        (await f.notifications(s.c, owner.id, 'instalment_plan.created')).map(
          (n) => [n.targetId, n.params],
        ),
      ).toEqual([[p.id, {}]]);
      const issued = (
        await f.notifications(s.c, owner.id, 'invoice.issued')
      ).map((n) => n.targetId);
      expect(issued).toEqual([invoiceId]);
      // The resident reads the plan and each instalment.
      const mine = body<Plan>(
        await f
          .http('get', `/instalment-plans/${p.id}`, owner.token)
          .expect(200),
      );
      expect(mine.instalments.map((i) => i.id)).toEqual(
        p.instalments.map((i) => i.id),
      );
      expect(
        body<InvoiceDetail>(
          await f
            .http('get', `/invoices/${p.instalments[0].id}`, owner.token)
            .expect(200),
        ).instalmentPlan,
      ).toMatchObject({ position: 1, count: 3 });
      // Staff lists filter by what the original now reads.
      const rescheduled = body<{ data: { id: string }[] }>(
        await f
          .http(
            'get',
            `/staff/invoices?unitId=${home.id}&status=rescheduled`,
            s.manager.token,
          )
          .expect(200),
      );
      expect(rescheduled.data.map((i) => i.id)).toEqual([invoiceId]);
      const credited = body<{ data: unknown[] }>(
        await f
          .http(
            'get',
            `/staff/invoices?unitId=${home.id}&status=credited`,
            s.manager.token,
          )
          .expect(200),
      );
      expect(credited.data).toEqual([]);
    });

    it('a partly paid original: what is still owed is split; it reads rescheduled, not paid', async () => {
      const home = await f.unit(s.c, 'A');
      const { invoiceId } = await f.issue(s.manager, home.id);
      await pay(home.id, '250').expect(201);
      const conflict = await convert(invoiceId, [
        { dueOn: day(5), amount: '500' },
        { dueOn: day(35), amount: '500' },
      ]).expect(409);
      expect(code(conflict)).toBe('INSTALMENTS_DONT_ADD_UP');
      expect(params(conflict)).toEqual({ outstanding: '750.00' });
      const p = body<Plan>(
        await convert(invoiceId, [
          { dueOn: day(5), amount: '375' },
          { dueOn: day(35), amount: '375' },
        ]).expect(201),
      );
      expect(p.total).toBe('750.00');
      expect(await invoice(invoiceId)).toMatchObject({
        status: 'rescheduled',
        paid: '250.00',
        credited: '750.00',
        outstanding: '0.00',
      });
    });

    it('an instalment, an invoice that has a plan, or one owing nothing cannot be split', async () => {
      const home = await f.unit(s.c, 'A');
      const { invoiceId } = await f.issue(s.manager, home.id);
      const p = body<Plan>(
        await convert(invoiceId, [
          { dueOn: day(5), amount: '500' },
          { dueOn: day(35), amount: '500' },
        ]).expect(201),
      );
      const again = await convert(invoiceId, [
        { dueOn: day(5), amount: '1' },
        { dueOn: day(6), amount: '1' },
      ]).expect(409);
      expect([code(again), params(again)]).toEqual([
        'INVOICE_NOT_CONVERTIBLE',
        { reason: 'has_plan' },
      ]);
      const nested = await convert(p.instalments[0].id, [
        { dueOn: day(5), amount: '250' },
        { dueOn: day(6), amount: '250' },
      ]).expect(409);
      expect(params(nested)).toEqual({ reason: 'instalment' });
      const settled = await f.issue(s.manager, home.id);
      await f
        .http(
          'post',
          `/staff/invoices/${settled.invoiceId}/credit-notes`,
          s.manager.token,
          { amount: '1000', reasonCode: 'waiver' },
        )
        .expect(201);
      const nothing = await convert(settled.invoiceId, [
        { dueOn: day(5), amount: '500' },
        { dueOn: day(6), amount: '500' },
      ]).expect(409);
      expect(params(nothing)).toEqual({ reason: 'nothing_owed' });
    });

    it('due dates rise, from today to 730 days out (the database agrees); each at least 1.00', async () => {
      const home = await f.unit(s.c, 'A');
      const { invoiceId } = await f.issue(s.manager, home.id);
      const fields = async (instalments: { dueOn: string; amount: string }[]) =>
        body<{ fields: { field: string; code: string }[] }>(
          await convert(invoiceId, instalments).expect(400),
        ).fields.map((x) => [x.field, x.code]);
      expect(
        await fields([
          { dueOn: day(10), amount: '500' },
          { dueOn: day(10), amount: '500' },
        ]),
      ).toEqual([['instalments.1.dueOn', 'DUE_DATES_NOT_INCREASING']]);
      expect(
        await fields([
          { dueOn: day(10), amount: '999.50' },
          { dueOn: day(20), amount: '0.50' },
        ]),
      ).toEqual([['instalments.1.amount', 'INVALID_VALUE']]);
      expect(
        await fields([
          { dueOn: day(-1), amount: '500' },
          { dueOn: day(20), amount: '500' },
        ]),
      ).toEqual([['instalments.0.dueOn', 'DUE_ON_OUT_OF_RANGE']]);
      expect(
        await fields([
          { dueOn: day(10), amount: '500' },
          { dueOn: addDays(day(0), 731), amount: '500' },
        ]),
      ).toEqual([['instalments.1.dueOn', 'DUE_ON_OUT_OF_RANGE']]);
      // Two years out is a valid instalment: the CHECK allows it.
      const p = body<Plan>(
        await convert(invoiceId, [
          { dueOn: day(0), amount: '500' },
          { dueOn: addDays(day(0), 730), amount: '500' },
        ]).expect(201),
      );
      expect(p.instalments[1].dueOn).toBe(addDays(day(0), 730));
    });

    it('converting closes the unit’s open checkout (its invoice changed)', async () => {
      const t = await f.setUp('Instalments Checkout');
      await f.configureGateway(t.manager);
      const { invoiceId } = await f.issue(t.manager, t.home.id);
      const session = body<{ id: string }>(
        await f
          .http(
            'post',
            `/units/${t.home.id}/payment-sessions`,
            t.owner.token,
            {},
          )
          .expect(201),
      );
      await f
        .http(
          'post',
          `/staff/invoices/${invoiceId}/instalment-plan`,
          t.accountant.token,
          {
            instalments: [
              { dueOn: day(5), amount: '500' },
              { dueOn: day(35), amount: '500' },
            ],
          },
        )
        .expect(201);
      const polled = body<{ status: string }>(
        await f
          .http('get', `/payment-sessions/${session.id}`, t.owner.token)
          .expect(200),
      );
      expect(polled.status).toBe('superseded');
    });

    it('the same Idempotency-Key makes one plan', async () => {
      const home = await f.unit(s.c, 'A');
      const { invoiceId } = await f.issue(s.manager, home.id);
      const send = () =>
        f
          .http(
            'post',
            `/staff/invoices/${invoiceId}/instalment-plan`,
            s.accountant.token,
            {
              instalments: [
                { dueOn: day(5), amount: '500' },
                { dueOn: day(35), amount: '500' },
              ],
            },
          )
          .set('Idempotency-Key', `ip-${invoiceId}`);
      const first = body<Plan>(await send().expect(201));
      const second = body<Plan>(await send().expect(201));
      expect(second.id).toBe(first.id);
      const list = body<{ data: { id: string }[] }>(
        await f
          .http(
            'get',
            `/staff/instalment-plans?unitId=${home.id}`,
            s.manager.token,
          )
          .expect(200),
      );
      expect(list.data.map((p) => p.id)).toEqual([first.id]);
    });
  });

  describe('paying and reminders', () => {
    it('each instalment is paid, reminded and overdue on its own; paid in full, the plan is settled', async () => {
      const home = await f.unit(s.c, 'A');
      const owner = await f.owner(s.c, home.id);
      const { invoiceId } = await f.issue(s.manager, home.id);
      const p = body<Plan>(
        await convert(invoiceId, [
          { dueOn: day(0), amount: '400' },
          { dueOn: day(30), amount: '600' },
        ]).expect(201),
      );
      const [first, second] = p.instalments;
      await backdateInvoice(first.id, 1);
      await sweep(INVOICE_REMINDERS_SWEEP);
      expect(
        (await f.notifications(s.c, owner.id, 'invoice.overdue')).map(
          (n) => n.targetId,
        ),
      ).toEqual([first.id]);
      // Nothing named: the oldest due instalment first.
      await pay(home.id, '500').expect(201);
      expect((await plan(p.id)).instalments.map((i) => i.paid)).toEqual([
        '400.00',
        '100.00',
      ]);
      await pay(home.id, '500', [second.id]).expect(201);
      expect(await plan(p.id)).toMatchObject({
        status: 'settled',
        outstanding: '0.00',
      });
      const settled = body<{ data: { id: string }[] }>(
        await f
          .http(
            'get',
            `/staff/instalment-plans?unitId=${home.id}&status=settled`,
            s.manager.token,
          )
          .expect(200),
      );
      expect(settled.data.map((x) => x.id)).toEqual([p.id]);
    });
  });

  describe('cancelling', () => {
    it('credits what the instalments owe and asks for it again in one invoice, announced', async () => {
      const home = await f.unit(s.c, 'A');
      const owner = await f.owner(s.c, home.id);
      const { invoiceId } = await f.issue(s.manager, home.id, {
        kind: 'other',
      });
      const p = body<Plan>(
        await convert(invoiceId, [
          { dueOn: day(5), amount: '300' },
          { dueOn: day(35), amount: '300' },
          { dueOn: day(65), amount: '400' },
        ]).expect(201),
      );
      await pay(home.id, '300', [p.instalments[0].id]).expect(201);
      await pay(home.id, '100', [p.instalments[1].id]).expect(201);
      const bad = await f
        .http(
          'post',
          `/staff/instalment-plans/${p.id}/cancel`,
          s.manager.token,
          {
            dueOn: addDays(day(0), 367),
          },
        )
        .expect(400);
      expect(body<{ fields: { code: string }[] }>(bad).fields[0].code).toBe(
        'DUE_ON_OUT_OF_RANGE',
      );
      const cancelled = body<Plan>(
        await f
          .http(
            'post',
            `/staff/instalment-plans/${p.id}/cancel`,
            s.manager.token,
            { dueOn: day(20) },
          )
          .expect(201),
      );
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        outstanding: '0.00',
        cancelledAt: expect.any(String) as string,
        remainderInvoiceId: expect.any(String) as string,
        remainderInvoiceNumber: expect.stringMatching(/^INV-/) as string,
      });
      expect(
        cancelled.instalments.map((i) => [i.status, i.paid, i.outstanding]),
      ).toEqual([
        ['paid', '300.00', '0.00'],
        ['rescheduled', '100.00', '0.00'],
        ['rescheduled', '0.00', '0.00'],
      ]);
      const remainder = await invoice(cancelled.remainderInvoiceId!);
      expect(remainder).toMatchObject({
        kind: 'other',
        total: '600.00',
        outstanding: '600.00',
        dueOn: day(20),
        lines: [
          {
            descriptionEn: `Remainder of instalment plan ${p.number}`,
            descriptionAr: `المتبقي من خطة التقسيط ${p.number}`,
            amount: '600.00',
          },
        ],
      });
      expect(
        (await f.notifications(s.c, owner.id, 'invoice.issued')).map(
          (n) => n.targetId,
        ),
      ).toContain(cancelled.remainderInvoiceId);
      const again = await f
        .http(
          'post',
          `/staff/instalment-plans/${p.id}/cancel`,
          s.manager.token,
          {
            dueOn: day(20),
          },
        )
        .expect(409);
      expect([code(again), params(again)]).toEqual([
        'INSTALMENT_PLAN_CLOSED',
        { status: 'cancelled' },
      ]);
    });

    it('a settled plan cannot be cancelled', async () => {
      const home = await f.unit(s.c, 'A');
      const { invoiceId } = await f.issue(s.manager, home.id);
      const p = body<Plan>(
        await convert(invoiceId, [
          { dueOn: day(5), amount: '500' },
          { dueOn: day(35), amount: '500' },
        ]).expect(201),
      );
      await pay(home.id, '1000').expect(201);
      const res = await f
        .http(
          'post',
          `/staff/instalment-plans/${p.id}/cancel`,
          s.manager.token,
          {
            dueOn: day(20),
          },
        )
        .expect(409);
      expect(params(res)).toEqual({ status: 'settled' });
    });

    it('conversions and cancellations of different units at once never deadlock on the counters', async () => {
      const ready = await Promise.all(
        [1, 2, 3, 4].map(async () => {
          const home = await f.unit(s.c, 'A');
          const a = await f.issue(s.manager, home.id);
          const b = await f.issue(s.manager, home.id);
          const p = body<Plan>(
            await convert(b.invoiceId, [
              { dueOn: day(5), amount: '500' },
              { dueOn: day(35), amount: '500' },
            ]).expect(201),
          );
          return { toConvert: a.invoiceId, toCancel: p.id };
        }),
      );
      const results = await Promise.all(
        ready.flatMap((r) => [
          convert(r.toConvert, [
            { dueOn: day(5), amount: '500' },
            { dueOn: day(35), amount: '500' },
          ]),
          f.http(
            'post',
            `/staff/instalment-plans/${r.toCancel}/cancel`,
            s.manager.token,
            { dueOn: day(20) },
          ),
        ]),
      );
      expect(results.map((r) => r.status)).toEqual(results.map(() => 201));
    });
  });

  describe('who sees it', () => {
    it('another unit’s resident cannot read a plan', async () => {
      const home = await f.unit(s.c, 'A');
      const other = await f.unit(s.c, 'A');
      const stranger = await f.owner(s.c, other.id);
      const { invoiceId } = await f.issue(s.manager, home.id);
      const p = body<Plan>(
        await convert(invoiceId, [
          { dueOn: day(5), amount: '500' },
          { dueOn: day(35), amount: '500' },
        ]).expect(201),
      );
      const res = await f
        .http('get', `/instalment-plans/${p.id}`, stranger.token)
        .expect(404);
      expect(code(res)).toBe('INSTALMENT_PLAN_NOT_FOUND');
    });
  });
});
