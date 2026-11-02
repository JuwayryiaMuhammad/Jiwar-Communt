import { err } from '../api/request';
import { at, day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  treasuryHelpers,
  type AccountBody,
  type HandinBody,
} from '../setup/treasury';

const ROUNDS = 5;

interface Custody {
  custodian: { id: string };
  expected: string;
  openCount: number;
  payments: { paymentId: string }[];
}

/**
 * ADR 0085, the owner's decision C1: custody is office cash recorded by a
 * collector or a cashier and not yet handed in, read from the payments. A
 * hand-in by another `finance.payments` holder takes it all into a cash
 * box against the amount shown; a variance has its reason, tells the
 * manager critically and stays open until settled — by the manager, or
 * through an investigation's owner. Nobody settles their own.
 */
describe('Treasury — custody', () => {
  let h: HttpHarness;
  let t: ReturnType<typeof treasuryHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof treasuryHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    t = treasuryHelpers(h);
    s = await t.setUp('Custody Court');
  }, 90_000);

  afterAll(() => h.close());

  const custody = async (accountId: string) =>
    (
      await t
        .http('get', `/staff/finance/custody/${accountId}`, s.manager.token)
        .expect(200)
    ).body as Custody;
  const balance = async (id: string) =>
    (
      (
        await t
          .http('get', `/staff/finance/cash-accounts/${id}`, s.manager.token)
          .expect(200)
      ).body as AccountBody
    ).balance;
  /** Hands in everything the accountant holds now, as the manager. */
  const settleAccountant = async () => {
    const now = await custody(s.accountant.id);
    if (now.openCount)
      await t
        .handIn(s.manager.token, s.accountant.id, {
          cashAccountId: s.cashBox.id,
          expected: now.expected,
          counted: now.expected,
        })
        .expect(201);
  };

  /** Cash a collector took on a visit to a new unit owing 1000. */
  async function collected(amount: string): Promise<string> {
    const unitId = await t.owingUnit(s);
    const owner = await t.owner(s.c, unitId);
    const visit = (
      await t
        .http('post', `/units/${unitId}/collector-visits`, owner.token, {
          windowStartsAt: at(day(1), 10).toISOString(),
          windowEndsAt: at(day(1), 12).toISOString(),
        })
        .expect(201)
    ).body as { id: string };
    await t
      .http(
        'post',
        `/staff/collector-visits/${visit.id}/assign`,
        s.accountant.token,
        {
          collectorId: s.collector.id,
        },
      )
      .expect(201);
    const done = await t
      .http(
        'post',
        `/collector/visits/${visit.id}/collected`,
        s.collector.token,
        { amount },
      )
      .expect(201);
    return (done.body as { paymentId: string }).paymentId;
  }

  it('a cashier’s cash is their custody until handed in; the collector reads their own', async () => {
    const unitId = await t.owingUnit(s);
    const one = await t.cash(s.accountant.token, unitId, '100');
    const two = await t.cash(s.accountant.token, unitId, '200');
    const mine = await custody(s.accountant.id);
    expect(mine).toMatchObject({ expected: '300.00', openCount: 2 });
    expect(mine.payments.map((p) => p.paymentId)).toEqual([one, two]);
    const list = (
      await t
        .http('get', '/staff/finance/custody', s.accountant.token)
        .expect(200)
    ).body as { data: { custodian: { id: string }; expected: string }[] };
    expect(list.data).toContainEqual(
      expect.objectContaining({
        custodian: expect.objectContaining({ id: s.accountant.id }),
        expected: '300.00',
      }),
    );
    const paid = await collected('150');
    const own = (
      await t.http('get', '/collector/custody', s.collector.token).expect(200)
    ).body as Custody;
    expect(own).toMatchObject({ expected: '150.00', openCount: 1 });
    expect(own.payments.map((p) => p.paymentId)).toEqual([paid]);
    await t
      .http('get', '/staff/finance/custody', s.collector.token)
      .expect(403);
  });

  it('nobody receives their own cash; the amount shown must still hold; a bank is no cash box', async () => {
    const now = await custody(s.accountant.id);
    expect(
      err(
        await t
          .handIn(s.accountant.token, s.accountant.id, {
            cashAccountId: s.cashBox.id,
            expected: now.expected,
            counted: now.expected,
          })
          .expect(403),
      ).code,
    ).toBe('CUSTODY_CONFLICT');
    expect(
      err(
        await t
          .handIn(s.manager.token, s.accountant.id, {
            cashAccountId: s.cashBox.id,
            expected: '1.00',
            counted: '1.00',
          })
          .expect(409),
      ),
    ).toMatchObject({
      code: 'CUSTODY_CHANGED',
      params: { expected: now.expected },
    });
    expect(
      err(
        await t
          .handIn(s.manager.token, s.accountant.id, {
            cashAccountId: s.bank.id,
            expected: now.expected,
            counted: now.expected,
          })
          .expect(409),
      ),
    ).toMatchObject({
      code: 'CASH_ACCOUNT_WRONG_KIND',
      params: { kind: 'cash' },
    });
  });

  it('a balanced hand-in takes every payment into the box once; nothing is left to hand in', async () => {
    const now = await custody(s.accountant.id);
    const before = Number(await balance(s.cashBox.id));
    const res = await t
      .handIn(s.manager.token, s.accountant.id, {
        cashAccountId: s.cashBox.id,
        expected: now.expected,
        counted: now.expected,
        varianceReason: 'other',
      })
      .expect(400);
    expect(err(res).fields).toEqual([
      { field: 'varianceReason', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const done = (
      await t
        .handIn(s.manager.token, s.accountant.id, {
          cashAccountId: s.cashBox.id,
          expected: now.expected,
          counted: now.expected,
        })
        .expect(201)
    ).body as HandinBody;
    expect(done).toMatchObject({
      status: 'balanced',
      variance: '0.00',
      paymentCount: now.openCount,
    });
    expect(done.number).toMatch(/^HI-\d{6}$/);
    expect(Number(await balance(s.cashBox.id))).toBeCloseTo(
      before + Number(now.expected),
      2,
    );
    expect((await custody(s.accountant.id)).openCount).toBe(0);
    expect(
      err(
        await t
          .handIn(s.manager.token, s.accountant.id, {
            cashAccountId: s.cashBox.id,
            expected: '0',
            counted: '0',
          })
          .expect(409),
      ).code,
    ).toBe('CUSTODY_EMPTY');
  });

  it('a payment reversed before the hand-in leaves the custody', async () => {
    const unitId = await t.owingUnit(s);
    const kept = await t.cash(s.accountant.token, unitId, '40');
    const gone = await t.cash(s.accountant.token, unitId, '60');
    await t
      .http('post', `/staff/payments/${gone}/reverse`, s.manager.token, {
        reasonCode: 'entered_in_error',
      })
      .expect(201);
    const now = await custody(s.accountant.id);
    expect(now).toMatchObject({ expected: '40.00', openCount: 1 });
    expect(now.payments.map((p) => p.paymentId)).toEqual([kept]);
    await settleAccountant();
  });

  it('a short count needs its reason, tells the manager critically, waits in the inbox and is settled once with what was recovered', async () => {
    const unitId = await t.owingUnit(s);
    await t.cash(s.accountant.token, unitId, '500');
    const missing = await t
      .handIn(s.manager.token, s.accountant.id, {
        cashAccountId: s.cashBox.id,
        expected: '500.00',
        counted: '480.00',
      })
      .expect(400);
    expect(err(missing).fields).toEqual([
      { field: 'varianceReason', code: 'FIELD_REQUIRED' },
    ]);
    const h1 = (
      await t
        .handIn(s.manager.token, s.accountant.id, {
          cashAccountId: s.cashBox.id,
          expected: '500.00',
          counted: '480.00',
          varianceReason: 'missing_cash',
        })
        .expect(201)
    ).body as HandinBody;
    expect(h1).toMatchObject({ status: 'variance', variance: '-20.00' });
    const told = await t.inTx(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'finance.custody_variance', targetId: h1.id },
      }),
    );
    expect(told.map((n) => n.accountId)).toEqual([s.manager.id]);
    expect(told[0].params).toEqual({ handinNumber: h1.number });
    const inbox = (
      await t
        .http('get', '/staff/inbox?type=custody_variance', s.manager.token)
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(inbox.data.map((i) => i.id)).toContain(h1.id);

    await t
      .http(
        'post',
        `/staff/finance/custody-handins/${h1.id}/resolve`,
        s.accountant.token,
        {
          reasonCode: 'recovered',
          recoveredAmount: '20',
        },
      )
      .expect(403);
    expect(
      err(
        await t
          .http(
            'post',
            `/staff/finance/custody-handins/${h1.id}/resolve`,
            s.manager.token,
            {
              reasonCode: 'recovered',
              recoveredAmount: '20.01',
            },
          )
          .expect(400),
      ).fields,
    ).toEqual([
      {
        field: 'recoveredAmount',
        code: 'INVALID_VALUE',
        params: { max: '20.00' },
      },
    ]);
    const box = Number(await balance(s.cashBox.id));
    const resolved = (
      await t
        .http(
          'post',
          `/staff/finance/custody-handins/${h1.id}/resolve`,
          s.manager.token,
          {
            reasonCode: 'recovered',
            recoveredAmount: '20',
          },
        )
        .expect(201)
    ).body as HandinBody & { outcome: string; recovered: string };
    expect(resolved).toMatchObject({
      status: 'resolved',
      outcome: 'recovered',
      recovered: '20.00',
    });
    expect(Number(await balance(s.cashBox.id))).toBeCloseTo(box + 20, 2);
    expect(
      err(
        await t
          .http(
            'post',
            `/staff/finance/custody-handins/${h1.id}/resolve`,
            s.manager.token,
            {
              reasonCode: 'written_off',
            },
          )
          .expect(409),
      ),
    ).toMatchObject({
      code: 'CUSTODY_HANDIN_NOT_OPEN',
      params: { status: 'resolved' },
    });
  });

  it('an investigation has an owner and a due day; its owner decides it, which settles the hand-in', async () => {
    await collected('300');
    const h2 = (
      await t
        .handIn(s.accountant.token, s.collector.id, {
          cashAccountId: s.cashBox.id,
          expected: '300.00',
          counted: '310.00',
          varianceReason: 'excess_cash',
        })
        .expect(201)
    ).body as HandinBody;
    const bad = await t
      .http(
        'post',
        `/staff/finance/custody-handins/${h2.id}/investigation`,
        s.manager.token,
        {
          ownerId: s.collector.id,
          dueOn: day(61),
        },
      )
      .expect(400);
    expect(err(bad).fields).toEqual([
      { field: 'ownerId', code: 'INVALID_VALUE' },
      {
        field: 'dueOn',
        code: 'INVALID_VALUE',
        params: { min: day(0), max: day(60) },
      },
    ]);
    const opened = (
      await t
        .http(
          'post',
          `/staff/finance/custody-handins/${h2.id}/investigation`,
          s.manager.token,
          {
            ownerId: s.accountant.id,
            dueOn: day(3),
          },
        )
        .expect(201)
    ).body as HandinBody;
    expect(opened.investigationId).not.toBeNull();
    expect(
      err(
        await t
          .http(
            'post',
            `/staff/finance/custody-handins/${h2.id}/resolve`,
            s.manager.token,
            {
              reasonCode: 'explained',
            },
          )
          .expect(409),
      ),
    ).toMatchObject({
      code: 'CUSTODY_INVESTIGATION_OPEN',
      params: { investigationId: opened.investigationId },
    });
    const notices = await t.inTx(s.c, (tx) =>
      tx.notification.findMany({
        where: {
          kind: 'finance.custody_investigation_assigned',
          targetId: opened.investigationId!,
        },
      }),
    );
    expect(notices.map((n) => n.accountId)).toEqual([s.accountant.id]);
    const theirs = (
      await t
        .http(
          'get',
          '/staff/finance/custody-investigations?status=open',
          s.accountant.token,
        )
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(theirs.data.map((i) => i.id)).toEqual([opened.investigationId]);
    expect(
      err(
        await t
          .http(
            'post',
            `/staff/finance/custody-investigations/${opened.investigationId}/decide`,
            s.accountant.token,
            {
              reasonCode: 'recovered',
              recoveredAmount: '5',
            },
          )
          .expect(400),
      ).fields,
    ).toEqual([
      {
        field: 'recoveredAmount',
        code: 'INVALID_VALUE',
        params: { max: '0.00' },
      },
    ]);
    const decided = (
      await t
        .http(
          'post',
          `/staff/finance/custody-investigations/${opened.investigationId}/decide`,
          s.accountant.token,
          {
            reasonCode: 'explained',
          },
        )
        .expect(201)
    ).body as { status: string; outcome: string };
    expect(decided).toMatchObject({ status: 'decided', outcome: 'explained' });
    const after = (
      await t
        .http('get', `/staff/finance/custody-handins/${h2.id}`, s.manager.token)
        .expect(200)
    ).body as HandinBody;
    expect(after.status).toBe('resolved');
    expect(
      err(
        await t
          .http(
            'post',
            `/staff/finance/custody-investigations/${opened.investigationId}/decide`,
            s.manager.token,
            {
              reasonCode: 'other',
            },
          )
          .expect(409),
      ).code,
    ).toBe('CUSTODY_INVESTIGATION_DECIDED');
  });

  it('open custody waits in the inbox for who keeps payments, oldest first', async () => {
    const unitId = await t.owingUnit(s);
    const first = await t.cash(s.accountant.token, unitId, '25');
    await t.cash(s.accountant.token, unitId, '35');
    const inbox = (
      await t
        .http('get', '/staff/inbox?type=cash_custody', s.accountant.token)
        .expect(200)
    ).body as { data: { id: string; number: string }[] };
    expect(inbox.data.map((i) => i.id)).toContain(first);
    await settleAccountant();
    const after = (
      await t
        .http('get', '/staff/inbox?type=cash_custody', s.accountant.token)
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(after.data.map((i) => i.id)).not.toContain(first);
  });

  describe('races', () => {
    it('two hand-ins of the same custody at once: one takes it, the other finds it empty', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const unitId = await t.owingUnit(s);
        await t.cash(s.accountant.token, unitId, '70');
        const body = {
          cashAccountId: s.cashBox.id,
          expected: '70.00',
          counted: '70.00',
        };
        const [a, b] = await Promise.all([
          t.handIn(s.manager.token, s.accountant.id, body),
          t.handIn(s.manager.token, s.accountant.id, body),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        expect(err([a, b].find((r) => r.status === 409)!).code).toBe(
          'CUSTODY_EMPTY',
        );
      }
    });

    it('a payment recorded while its custody is handed in: in the hand-in whole, or left for the next', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const unitId = await t.owingUnit(s);
        await t.cash(s.accountant.token, unitId, '80');
        const [handed, paid] = await Promise.all([
          t.handIn(s.manager.token, s.accountant.id, {
            cashAccountId: s.cashBox.id,
            expected: '80.00',
            counted: '80.00',
          }),
          t.http(
            'post',
            `/staff/units/${unitId}/payments`,
            s.accountant.token,
            {
              amount: '20',
              method: 'cash',
              paidOn: day(0),
            },
          ),
        ]);
        expect(paid.status).toBe(201);
        const left = await custody(s.accountant.id);
        if (handed.status === 201) {
          // The payment landed after: it is the next custody, alone.
          expect((handed.body as HandinBody).paymentCount).toBe(1);
          expect(left).toMatchObject({ expected: '20.00', openCount: 1 });
        } else {
          // It landed first: the hand-in saw a custody other than shown.
          expect(err(handed)).toMatchObject({
            code: 'CUSTODY_CHANGED',
            params: { expected: '100.00' },
          });
          expect(left).toMatchObject({ expected: '100.00', openCount: 2 });
        }
        await settleAccountant();
      }
    });

    it('a reversal while the custody is handed in: never in a hand-in and reversed both', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const unitId = await t.owingUnit(s);
        const p = await t.cash(s.accountant.token, unitId, '90');
        const [handed, reversed] = await Promise.all([
          t.handIn(s.manager.token, s.accountant.id, {
            cashAccountId: s.cashBox.id,
            expected: '90.00',
            counted: '90.00',
          }),
          t.http('post', `/staff/payments/${p}/reverse`, s.manager.token, {
            reasonCode: 'duplicate',
          }),
        ]);
        expect(reversed.status).toBe(201);
        if (handed.status !== 201)
          expect(err(handed).code).toMatch(/^CUSTODY_(EMPTY|CHANGED)$/);
        const items = await t.inTx(s.c, (tx) =>
          tx.financeCustodyHandinItem.findMany({ where: { paymentId: p } }),
        );
        // Handed in first, then reversed: the cash was counted, the item stays.
        expect(items).toHaveLength(handed.status === 201 ? 1 : 0);
        await settleAccountant();
      }
    });
  });
});
