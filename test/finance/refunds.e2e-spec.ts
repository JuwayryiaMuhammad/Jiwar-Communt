import type { Response } from 'supertest';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { addDays } from '../../src/core/common/slots/day-slots';
import { day } from '../setup/facilities';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';

interface Refund {
  id: string;
  number: string;
  amount: string;
  channel: string;
  reference: string | null;
  refundedOn: string;
  recordedBy: { id: string; fullName: string | null };
  sources: { paymentId: string; amount: string }[];
  reversal: { reasonCode: string } | null;
}
interface Statement {
  outstanding: string;
  credit: string;
  entries: { kind: string; number: string; amount: string }[];
}

const body = <T>(res: Response) => res.body as T;
const code = (res: Response) => body<{ code: string }>(res).code;
const params = (res: Response) =>
  body<{ params: Record<string, unknown> }>(res).params;

/**
 * Refunds of a unit's credit (ADR 0048): the manager's alone, after a
 * step-up; at most the credit when recorded, taken from the newest free
 * money; the allocator never pours what was paid back; a reversal returns
 * the money to credit, which pays what is owed at once.
 */
describe('Finance — refunds', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Refunds Court');
  });

  afterAll(() => h.close());

  const refund = (
    unitId: string,
    amount: string,
    over: Record<string, unknown> = {},
    token = s.manager.token,
  ) =>
    f.http('post', `/staff/units/${unitId}/refunds`, token, {
      amount,
      channel: 'cash',
      refundedOn: day(0),
      ...over,
    });
  const statement = async (unitId: string) =>
    body<Statement>(
      await f
        .http('get', `/staff/units/${unitId}/statement`, s.manager.token)
        .expect(200),
    );

  it('at most the unit’s credit; the statement shows the refund and the credit net of it', async () => {
    const home = await f.unit(s.c, 'A');
    await f.giveCredit(s.c, home.id, '500');
    await f.stepUp(s.manager.token);
    const over = await refund(home.id, '600').expect(409);
    expect([code(over), params(over)]).toEqual([
      'REFUND_EXCEEDS_CREDIT',
      { credit: '500.00' },
    ]);
    // The refused refund rolled back: the step-up is still there.
    const r = body<Refund>(
      await refund(home.id, '200', {
        channel: 'gateway_manual',
        reference: 'PMB-REF-9',
      }).expect(201),
    );
    expect(r).toMatchObject({
      number: expect.stringMatching(/^RF-\d{6}$/) as string,
      amount: '200.00',
      channel: 'gateway_manual',
      reference: 'PMB-REF-9',
      refundedOn: day(0),
      recordedBy: { id: s.manager.id },
      reversal: null,
    });
    const st = await statement(home.id);
    expect(st).toMatchObject({ outstanding: '0.00', credit: '300.00' });
    expect(st.entries[0]).toEqual(
      expect.objectContaining({
        kind: 'refund',
        number: r.number,
        amount: '200.00',
      }),
    );
  });

  it('needs a step-up, spends it once, and a replay spends none', async () => {
    const home = await f.unit(s.c, 'A');
    await f.giveCredit(s.c, home.id, '500');
    expect(code(await refund(home.id, '10').expect(403))).toBe(
      'STEP_UP_REQUIRED',
    );
    await f.stepUp(s.manager.token);
    const key = `rf-${uniqueSuffix()}`;
    const first = body<Refund>(
      await refund(home.id, '10').set('Idempotency-Key', key).expect(201),
    );
    const replay = body<Refund>(
      await refund(home.id, '10').set('Idempotency-Key', key).expect(201),
    );
    expect(replay.id).toBe(first.id);
    expect(code(await refund(home.id, '10').expect(403))).toBe(
      'STEP_UP_REQUIRED',
    );
    expect((await statement(home.id)).credit).toBe('490.00');
  });

  it('the manager’s alone: the accountant may not refund', async () => {
    const home = await f.unit(s.c, 'A');
    const res = await refund(home.id, '1', {}, s.accountant.token).expect(403);
    expect(code(res)).toBe('FORBIDDEN');
  });

  it('a day from a month ago to today', async () => {
    const home = await f.unit(s.c, 'A');
    await f.giveCredit(s.c, home.id, '50');
    await f.stepUp(s.manager.token);
    const res = await refund(home.id, '10', {
      refundedOn: addDays(day(0), -32),
    }).expect(400);
    expect(
      body<{ fields: { field: string; code: string }[] }>(res).fields,
    ).toEqual([
      expect.objectContaining({
        field: 'refundedOn',
        code: 'REFUNDED_ON_OUT_OF_RANGE',
      }),
    ]);
  });

  it('takes the newest free money first; the payments show what was refunded', async () => {
    const home = await f.unit(s.c, 'A');
    const older = await f.giveCredit(s.c, home.id, '100');
    const newer = await f.giveCredit(s.c, home.id, '200');
    await f.stepUp(s.manager.token);
    const r = body<Refund>(await refund(home.id, '250').expect(201));
    expect(r.sources.map((x) => [x.paymentId, x.amount])).toEqual([
      [newer, '200.00'],
      [older, '50.00'],
    ]);
    const payment = body<{ refunded: string; unallocated: string }>(
      await f
        .http('get', `/staff/payments/${older}`, s.manager.token)
        .expect(200),
    );
    expect(payment).toMatchObject({ refunded: '50.00', unallocated: '50.00' });
  });

  it('the allocator never pours refunded money; a reversal returns it, and it pays what is owed', async () => {
    const home = await f.unit(s.c, 'A');
    const paymentId = await f.giveCredit(s.c, home.id, '300');
    await f.stepUp(s.manager.token);
    const r = body<Refund>(await refund(home.id, '300').expect(201));
    const { invoiceId } = await f.issue(s.manager, home.id, {
      lines: [{ descriptionEn: 'Fee', descriptionAr: 'رسم', amount: '100' }],
    });
    const owed = async () =>
      body<{ outstanding: string }>(
        await f
          .http('get', `/staff/invoices/${invoiceId}`, s.manager.token)
          .expect(200),
      ).outstanding;
    expect(await owed()).toBe('100.00');
    // A payment money was refunded from cannot be reversed.
    const blocked = await f
      .http('post', `/staff/payments/${paymentId}/reverse`, s.manager.token, {
        reasonCode: 'entered_in_error',
      })
      .expect(409);
    expect(code(blocked)).toBe('PAYMENT_REFUNDED');
    const reversed = body<Refund>(
      await f
        .http('post', `/staff/refunds/${r.id}/reverse`, s.manager.token, {
          reasonCode: 'refund_failed',
        })
        .expect(201),
    );
    expect(reversed.reversal).toMatchObject({ reasonCode: 'refund_failed' });
    expect(await owed()).toBe('0.00');
    const st = await statement(home.id);
    expect(st).toMatchObject({ outstanding: '0.00', credit: '200.00' });
    expect(st.entries.map((e) => e.kind)).toContain('refund_reversal');
    const again = await f
      .http('post', `/staff/refunds/${r.id}/reverse`, s.manager.token, {
        reasonCode: 'refund_failed',
      })
      .expect(409);
    expect(code(again)).toBe('REFUND_ALREADY_REVERSED');
    // With its refund undone, the payment may be reversed again.
    await f
      .http('post', `/staff/payments/${paymentId}/reverse`, s.manager.token, {
        reasonCode: 'entered_in_error',
      })
      .expect(201);
  });

  it('two refunds of the same credit at once: one fits, the other is refused with what is left', async () => {
    const home = await f.unit(s.c, 'A');
    await f.giveCredit(s.c, home.id, '500');
    const second = await secondManager();
    await f.stepUp(s.manager.token);
    await f.stepUp(second.token);
    const both = await Promise.all([
      refund(home.id, '300'),
      refund(home.id, '300', {}, second.token),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = both.find((r) => r.status === 409)!;
    expect([code(refused), params(refused)]).toEqual([
      'REFUND_EXCEEDS_CREDIT',
      { credit: '200.00' },
    ]);
  });

  it.each([1, 2, 3])(
    'round %i: a refund while its manager is deactivated: one or the other, never a deadlock',
    async () => {
      const home = await f.unit(s.c, 'A');
      await f.giveCredit(s.c, home.id, '100');
      const second = await secondManager();
      await f.stepUp(second.token);
      const [res] = await Promise.all([
        refund(home.id, '100', {}, second.token),
        f.x.asManager(s.c, () =>
          h.moduleRef
            .get(AccountsService)
            .updateStatus(second.id, { status: 'inactive' }),
        ),
      ]);
      expect([201, 401]).toContain(res.status);
      expect((await statement(home.id)).credit).toBe(
        res.status === 201 ? '0.00' : '100.00',
      );
    },
  );

  /** Another manager of the compound, with a session. */
  async function secondManager() {
    const account = await f.x.asManager(s.c, () =>
      h.moduleRef.get(AccountsService).create({
        type: 'manager',
        fullName: `Manager ${uniqueSuffix()}`,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        phone: uniquePhone(),
        email: uniqueEmail('manager'),
      }),
    );
    return f.who(s.c, account.id, 'manager');
  }
});
