import type { Response } from 'supertest';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { INVOICE_NOTICES_SWEEP } from '../../src/finance/invoices/invoice-notices.sweep';
import { day } from '../setup/facilities';
import {
  backdateInvoice,
  financeHelpers,
  type FinanceSetUp,
} from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface InvoiceBody {
  id: string;
  number: string;
  unitId: string;
  unitCode: string;
  total: string;
  credited: string;
  paid: string;
  outstanding: string;
  status: string;
  dueOn: string;
  lines?: { position: number; descriptionEn: string; amount: string }[];
  creditNotes?: { number: string; amount: string; reasonCode: string }[];
}

const body = <T>(res: Response) => res.body as T;
const code = (res: Response) => body<{ code: string }>(res).code;

/**
 * Invoices (ADR 0046): issued to one unit, a building or every unit, each
 * numbered, immutable, corrected by credit notes; seen by whoever sees the
 * unit's money; announced once.
 */
describe('Finance — invoices', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Invoices Court');
  });

  afterAll(() => h.close());

  const issueRaw = (token: string, over: Record<string, unknown>) =>
    f.http('post', '/staff/invoices', token, {
      target: 'unit',
      unitId: s.home.id,
      kind: 'service_charge',
      dueOn: day(10),
      lines: [
        {
          descriptionEn: 'Service charge',
          descriptionAr: 'رسوم الخدمات',
          amount: '700',
        },
        { descriptionEn: 'Water', descriptionAr: 'مياه', amount: '300.50' },
      ],
      ...over,
    });
  const invoice = async (token: string, id: string) =>
    body<InvoiceBody>(
      await f.http('get', `/staff/invoices/${id}`, token).expect(200),
    );

  describe('issuing', () => {
    it('one unit: a batch, an invoice with its lines, owed in full, announced to who sees the money', async () => {
      const res = await issueRaw(s.manager.token, {}).expect(201);
      const batch = body<{
        id: string;
        unitCount: number;
        total: string;
        firstNumber: string;
        lastNumber: string;
        target: string;
        dueOn: string;
      }>(res);
      expect(batch).toMatchObject({
        target: 'unit',
        unitCount: 1,
        total: '1000.50',
        dueOn: day(10),
      });
      expect(batch.firstNumber).toMatch(/^INV-\d{6}$/);
      expect(batch.lastNumber).toBe(batch.firstNumber);
      const list = await f
        .http('get', `/staff/invoices?batchId=${batch.id}`, s.manager.token)
        .expect(200);
      const [row] = body<{ data: InvoiceBody[] }>(list).data;
      const detail = await invoice(s.manager.token, row.id);
      expect(detail).toMatchObject({
        number: batch.firstNumber,
        unitId: s.home.id,
        unitCode: s.home.code,
        total: '1000.50',
        credited: '0.00',
        paid: '0.00',
        outstanding: '1000.50',
        status: 'unpaid',
      });
      expect(detail.lines).toEqual([
        {
          position: 1,
          descriptionEn: 'Service charge',
          descriptionAr: 'رسوم الخدمات',
          amount: '700.00',
        },
        {
          position: 2,
          descriptionEn: 'Water',
          descriptionAr: 'مياه',
          amount: '300.50',
        },
      ]);
      const told = await f.notifications(s.c, s.owner.id, 'invoice.issued');
      expect(told.map((n) => [n.targetId, n.params])).toContainEqual([
        row.id,
        {},
      ]);
    });

    it('a building: one invoice per unit of the building, consecutive numbers', async () => {
      const c = await f.setUp('Invoices Building');
      const b1 = await f.unit(c.c, 'B');
      const b2 = await f.unit(c.c, 'B');
      await f.unit(c.c, 'C');
      const res = await f
        .http('post', '/staff/invoices', c.manager.token, {
          target: 'building',
          building: 'B',
          kind: 'maintenance',
          dueOn: day(5),
          lines: [
            { descriptionEn: 'Lift', descriptionAr: 'المصعد', amount: '250' },
          ],
        })
        .expect(201);
      const batch = body<{
        id: string;
        unitCount: number;
        firstNumber: string;
        lastNumber: string;
      }>(res);
      expect(batch.unitCount).toBe(2);
      const rows = body<{ data: InvoiceBody[] }>(
        await f
          .http('get', `/staff/invoices?batchId=${batch.id}`, c.manager.token)
          .expect(200),
      ).data;
      expect(rows.map((r) => r.unitId).sort()).toEqual([b1.id, b2.id].sort());
      const numbers = rows.map((r) => Number(r.number.slice(4))).sort();
      expect(numbers[1] - numbers[0]).toBe(1);
      expect([batch.firstNumber, batch.lastNumber]).toEqual(
        numbers.map((n) => `INV-${String(n).padStart(6, '0')}`),
      );
    });

    it('every unit; a big issue is announced by the sweep, once', async () => {
      const c = await f.setUp('Invoices All');
      for (let i = 0; i < 51; i++) await f.unit(c.c, 'D');
      const res = await f
        .http('post', '/staff/invoices', c.manager.token, {
          target: 'all',
          kind: 'other',
          dueOn: day(20),
          lines: [
            { descriptionEn: 'Gate', descriptionAr: 'البوابة', amount: '10' },
          ],
        })
        .expect(201);
      expect(body<{ unitCount: number }>(res).unitCount).toBe(52);
      // 52 > 50: nobody told yet.
      expect(await f.notifications(c.c, c.owner.id, 'invoice.issued')).toEqual(
        [],
      );
      const sweep = h.moduleRef.get(SweepRunner);
      expect(
        await sweep.run(INVOICE_NOTICES_SWEEP, new Date()),
      ).toBeGreaterThanOrEqual(52);
      expect(
        await f.notifications(c.c, c.owner.id, 'invoice.issued'),
      ).toHaveLength(1);
      await sweep.run(INVOICE_NOTICES_SWEEP, new Date());
      expect(
        await f.notifications(c.c, c.owner.id, 'invoice.issued'),
      ).toHaveLength(1);
    });

    it('an Idempotency-Key replays the same batch; another body under it conflicts', async () => {
      const key = `issue-${Date.now()}`;
      const first = await issueRaw(s.manager.token, {})
        .set('Idempotency-Key', key)
        .expect(201);
      const again = await issueRaw(s.manager.token, {})
        .set('Idempotency-Key', key)
        .expect(201);
      expect(body<{ id: string }>(again).id).toBe(
        body<{ id: string }>(first).id,
      );
      const rows = await f
        .http(
          'get',
          `/staff/invoices?batchId=${body<{ id: string }>(first).id}`,
          s.manager.token,
        )
        .expect(200);
      expect(body<{ data: unknown[] }>(rows).data).toHaveLength(1);
      const other = await issueRaw(s.manager.token, { kind: 'other' })
        .set('Idempotency-Key', key)
        .expect(409);
      expect(code(other)).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('refuses a mismatched target, a due date out of range, too large a total, an empty building, another compound’s unit', async () => {
      const fields = async (over: Record<string, unknown>) =>
        body<{ fields: unknown[] }>(
          await issueRaw(s.manager.token, over).expect(400),
        ).fields;
      expect(await fields({ target: 'unit', unitId: undefined })).toEqual([
        { field: 'unitId', code: 'FIELD_REQUIRED' },
      ]);
      expect(await fields({ target: 'all', building: 'A' })).toEqual([
        { field: 'unitId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'building', code: 'FIELD_NOT_ALLOWED' },
      ]);
      expect(await fields({ dueOn: day(-1) })).toEqual([
        {
          field: 'dueOn',
          code: 'DUE_ON_OUT_OF_RANGE',
          params: { min: day(0), max: day(366) },
        },
      ]);
      expect(
        await fields({
          lines: [
            { descriptionEn: 'a', descriptionAr: 'ب', amount: '600000' },
            { descriptionEn: 'b', descriptionAr: 'ج', amount: '400000.01' },
          ],
        }),
      ).toEqual([
        {
          field: 'lines',
          code: 'INVOICE_TOTAL_TOO_LARGE',
          params: { max: '1000000.00' },
        },
      ]);
      const empty = await issueRaw(s.manager.token, {
        target: 'building',
        unitId: undefined,
        building: 'Nowhere',
      }).expect(422);
      expect(code(empty)).toBe('INVOICE_BATCH_EMPTY');
      const other = await f.setUp('Invoices Elsewhere');
      expect(
        code(
          await issueRaw(s.manager.token, { unitId: other.home.id }).expect(
            404,
          ),
        ),
      ).toBe('UNIT_NOT_FOUND');
    });

    it('the accountant issues; a guard does not', async () => {
      await issueRaw(s.accountant.token, {}).expect(201);
      const guard = await f.staff(s.c, []);
      await issueRaw(guard.token, {}).expect(403);
    });
  });

  describe('releasing paid money (ADR 0048)', () => {
    const pay = (unitId: string, amount: string, invoiceIds: string[]) =>
      f
        .http('post', `/staff/units/${unitId}/payments`, s.accountant.token, {
          amount,
          method: 'cash',
          paidOn: day(0),
          invoiceIds,
        })
        .expect(201);
    const credit = (invoiceId: string, amount: string) =>
      f.http(
        'post',
        `/staff/invoices/${invoiceId}/credit-notes`,
        s.manager.token,
        { amount, reasonCode: 'billing_error' },
      );
    const statement = async (unitId: string) =>
      body<{ outstanding: string; credit: string }>(
        await f
          .http('get', `/staff/units/${unitId}/statement`, s.manager.token)
          .expect(200),
      );
    const detail = async (id: string) =>
      body<
        InvoiceBody & {
          allocations: { amount: string; released: string }[];
          creditNotes: { amount: string; released: string }[];
        }
      >(
        await f
          .http('get', `/staff/invoices/${id}`, s.manager.token)
          .expect(200),
      );

    it('beyond what is owed, a credit note gives the newest payments back to credit, splitting the last', async () => {
      const home = await f.unit(s.c, 'A');
      const { invoiceId } = await f.issue(s.manager, home.id);
      await pay(home.id, '400', [invoiceId]);
      await pay(home.id, '600', [invoiceId]);
      const note = body<{ amount: string; released: string }>(
        await credit(invoiceId, '700').expect(201),
      );
      expect(note).toMatchObject({ amount: '700.00', released: '700.00' });
      const inv = await detail(invoiceId);
      expect(inv).toMatchObject({
        credited: '700.00',
        paid: '300.00',
        outstanding: '0.00',
        status: 'paid',
      });
      expect(inv.allocations.map((a) => [a.amount, a.released])).toEqual([
        ['400.00', '100.00'],
        ['600.00', '600.00'],
      ]);
      expect(await statement(home.id)).toMatchObject({
        outstanding: '0.00',
        credit: '700.00',
      });
      // Up to the total less credit notes: 300 more, never 300.01.
      const over = await credit(invoiceId, '300.01').expect(409);
      expect(body<{ params: object }>(over).params).toEqual({
        creditable: '300.00',
        outstanding: '0.00',
      });
      await credit(invoiceId, '300').expect(201);
      expect(await detail(invoiceId)).toMatchObject({
        paid: '0.00',
        status: 'credited',
      });
      expect((await statement(home.id)).credit).toBe('1000.00');
    });

    it('on a partly paid invoice, what it owes is credited first, then the payment released', async () => {
      const home = await f.unit(s.c, 'A');
      const { invoiceId } = await f.issue(s.manager, home.id);
      await pay(home.id, '400', [invoiceId]);
      const note = body<{ released: string }>(
        await credit(invoiceId, '800').expect(201),
      );
      expect(note.released).toBe('200.00');
      expect(await detail(invoiceId)).toMatchObject({
        credited: '800.00',
        paid: '200.00',
        outstanding: '0.00',
      });
      expect((await statement(home.id)).credit).toBe('200.00');
    });

    it('released money pays the unit’s other open invoices at once', async () => {
      const home = await f.unit(s.c, 'A');
      const paid = await f.issue(s.manager, home.id);
      await pay(home.id, '1000', [paid.invoiceId]);
      const other = await f.issue(s.manager, home.id, { dueOn: day(20) });
      await credit(paid.invoiceId, '300').expect(201);
      expect(await detail(other.invoiceId)).toMatchObject({
        paid: '300.00',
        outstanding: '700.00',
      });
      expect(await statement(home.id)).toMatchObject({
        outstanding: '700.00',
        credit: '0.00',
      });
    });

    it('released money can be refunded; then its payment cannot be reversed; reversing a payment drops its released money too', async () => {
      const home = await f.unit(s.c, 'A');
      const a = await f.issue(s.manager, home.id);
      const refunded = body<{ id: string }>(
        await pay(home.id, '1000', [a.invoiceId]),
      ).id;
      await credit(a.invoiceId, '1000').expect(201);
      await f.stepUp(s.manager.token);
      await f
        .http('post', `/staff/units/${home.id}/refunds`, s.manager.token, {
          amount: '1000',
          channel: 'bank_transfer',
          refundedOn: day(0),
        })
        .expect(201);
      expect((await statement(home.id)).credit).toBe('0.00');
      expect(
        code(
          await f
            .http(
              'post',
              `/staff/payments/${refunded}/reverse`,
              s.manager.token,
              {
                reasonCode: 'entered_in_error',
              },
            )
            .expect(409),
        ),
      ).toBe('PAYMENT_REFUNDED');

      const b = await f.issue(s.manager, home.id);
      const reversed = body<{ id: string }>(
        await pay(home.id, '1000', [b.invoiceId]),
      ).id;
      await credit(b.invoiceId, '400').expect(201);
      expect((await statement(home.id)).credit).toBe('400.00');
      await f
        .http('post', `/staff/payments/${reversed}/reverse`, s.manager.token, {
          reasonCode: 'bounced_cheque',
        })
        .expect(201);
      // The payment is gone, its released money with it; the invoice owes
      // what the credit note did not take.
      expect(await statement(home.id)).toMatchObject({
        outstanding: '600.00',
        credit: '0.00',
      });
    });
  });

  describe('credit notes', () => {
    it('reduce what is owed; never past the total less credit notes; a full credit leaves it credited', async () => {
      const { invoiceId } = await f.issue(s.manager, s.home.id);
      const credit = (amount: string, reasonCode = 'waiver') =>
        f.http(
          'post',
          `/staff/invoices/${invoiceId}/credit-notes`,
          s.manager.token,
          {
            amount,
            reasonCode,
          },
        );
      const first = await credit('250').expect(201);
      expect(body<{ number: string; amount: string }>(first)).toMatchObject({
        amount: '250.00',
        reasonCode: 'waiver',
        invoiceId,
      });
      expect(body<{ number: string }>(first).number).toMatch(/^CN-\d{6}$/);
      expect(await invoice(s.manager.token, invoiceId)).toMatchObject({
        credited: '250.00',
        outstanding: '750.00',
        status: 'unpaid',
      });
      const over = await credit('750.01').expect(409);
      expect(code(over)).toBe('CREDIT_EXCEEDS_CREDITABLE');
      expect(body<{ params: object }>(over).params).toEqual({
        creditable: '750.00',
        outstanding: '750.00',
      });
      await credit('750', 'billing_error').expect(201);
      const detail = await invoice(s.manager.token, invoiceId);
      expect(detail).toMatchObject({ outstanding: '0.00', status: 'credited' });
      expect(detail.creditNotes?.map((n) => [n.amount, n.reasonCode])).toEqual([
        ['250.00', 'waiver'],
        ['750.00', 'billing_error'],
      ]);
      expect(code(await credit('1').expect(409))).toBe(
        'CREDIT_EXCEEDS_CREDITABLE',
      );
    });

    it('a reason code from the list only', async () => {
      const { invoiceId } = await f.issue(s.manager, s.home.id);
      const res = await f
        .http(
          'post',
          `/staff/invoices/${invoiceId}/credit-notes`,
          s.manager.token,
          {
            amount: '10',
            reasonCode: 'because',
          },
        )
        .expect(400);
      expect(body<{ fields: unknown[] }>(res).fields).toEqual([
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: {
            allowed: [
              'billing_error',
              'waiver',
              'duplicate',
              'goodwill',
              'compensation',
              'other',
            ],
          },
        },
      ]);
    });
  });

  describe('where an invoice stands', () => {
    it('overdue after its due date; the filters agree with the statuses', async () => {
      const c = await f.setUp('Invoices Status');
      const late = await f.issue(c.manager, c.home.id);
      await backdateInvoice(late.invoiceId, 15);
      const open = await f.issue(c.manager, c.home.id);
      const credited = await f.issue(c.manager, c.home.id);
      await f
        .http(
          'post',
          `/staff/invoices/${credited.invoiceId}/credit-notes`,
          c.manager.token,
          {
            amount: '1000',
            reasonCode: 'duplicate',
          },
        )
        .expect(201);
      const ids = async (status: string) =>
        body<{ data: InvoiceBody[] }>(
          await f
            .http(
              'get',
              `/units/${c.home.id}/invoices?status=${status}`,
              c.owner.token,
            )
            .expect(200),
        ).data.map((i) => i.id);
      expect(await ids('overdue')).toEqual([late.invoiceId]);
      expect(await ids('unpaid')).toEqual([open.invoiceId]);
      expect(await ids('credited')).toEqual([credited.invoiceId]);
      expect((await ids('open')).sort()).toEqual(
        [late.invoiceId, open.invoiceId].sort(),
      );
      expect(await ids('paid')).toEqual([]);
      expect((await invoice(c.manager.token, late.invoiceId)).status).toBe(
        'overdue',
      );
    });

    it('pages newest first with a cursor', async () => {
      const c = await f.setUp('Invoices Pages');
      const made: string[] = [];
      for (let i = 0; i < 3; i++)
        made.push((await f.issue(c.manager, c.home.id)).invoiceId);
      const first = body<{ data: InvoiceBody[]; nextCursor: string }>(
        await f
          .http('get', '/staff/invoices?limit=2', c.manager.token)
          .expect(200),
      );
      expect(first.data.map((i) => i.id)).toEqual([made[2], made[1]]);
      const second = body<{ data: InvoiceBody[]; nextCursor: string | null }>(
        await f
          .http(
            'get',
            `/staff/invoices?limit=2&cursor=${first.nextCursor}`,
            c.manager.token,
          )
          .expect(200),
      );
      expect(second.data.map((i) => i.id)).toEqual([made[0]]);
      expect(second.nextCursor).toBeNull();
    });
  });

  describe('who sees a unit’s invoices', () => {
    it('owners (landlords too) and tenants; a member with the finance grant; nobody else', async () => {
      const c = await f.setUp('Invoices Who');
      const rented = await f.unit(c.c, 'A');
      const landlord = await f.landlord(c.c, rented.id);
      const tenant = await f.tenant(c.c, rented.id);
      const member = await f.family(c.c, c.home.id, c.owner);
      const neighbour = await f.owner(c.c, (await f.unit(c.c, 'A')).id);
      const home = await f.issue(c.manager, c.home.id);
      const rent = await f.issue(c.manager, rented.id);

      const list = (who: { token: string }, unitId: string) =>
        f.http('get', `/units/${unitId}/invoices`, who.token);
      const one = (who: { token: string }, id: string) =>
        f.http('get', `/invoices/${id}`, who.token);

      await list(c.owner, c.home.id).expect(200);
      await one(c.owner, home.invoiceId).expect(200);
      await list(landlord, rented.id).expect(200);
      await one(landlord, rent.invoiceId).expect(200);
      await list(tenant, rented.id).expect(200);
      await one(tenant, rent.invoiceId).expect(200);

      // A member without the grant: their unit, but not its money.
      expect(code(await list(member, c.home.id).expect(403))).toBe('FORBIDDEN');
      expect(code(await one(member, home.invoiceId).expect(404))).toBe(
        'INVOICE_NOT_FOUND',
      );
      await f.grantFinance(c.c, c.owner, member.memberId);
      await list(member, c.home.id).expect(200);
      await one(member, home.invoiceId).expect(200);

      // Another unit's owner: not found, either way.
      expect(code(await list(neighbour, c.home.id).expect(404))).toBe(
        'UNIT_NOT_FOUND',
      );
      expect(code(await one(neighbour, home.invoiceId).expect(404))).toBe(
        'INVOICE_NOT_FOUND',
      );
      // Everyone who sees the money was told, nobody else.
      for (const who of [landlord, tenant])
        expect(
          (await f.notifications(c.c, who.id, 'invoice.issued')).map(
            (n) => n.targetId,
          ),
        ).toEqual([rent.invoiceId]);
      expect(
        await f.notifications(c.c, neighbour.id, 'invoice.issued'),
      ).toEqual([]);
    });
  });
});
