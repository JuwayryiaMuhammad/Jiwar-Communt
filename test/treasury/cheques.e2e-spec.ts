import { Client } from 'pg';
import { ChequesService } from '../../src/finance/treasury/cheques.service';
import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';
import {
  treasuryHelpers,
  type AccountBody,
  type ChequeBody,
} from '../setup/treasury';

const ROUNDS = 5;

/** Moves a held cheque's due day into the past (TEST-ONLY: skips the triggers). */
async function dueAlready(chequeId: string): Promise<void> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(
      `UPDATE finance_cheques SET due_on = received_on, received_on = received_on - 1 WHERE id = $1`,
      [chequeId],
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}

/**
 * ADR 0085: the cheque register. A cheque dated today or earlier pays at
 * once (an office payment by cheque, which the register now holds too); a
 * post-dated one is held, told due once, and pays when deposited.
 * Deposited → cleared (into the bank) or bounced (its payment reversed:
 * the invoices it paid are owed again); a cheque not yet deposited may be
 * given back. A clear and a bounce at once: one wins.
 */
describe('Treasury — the cheque register', () => {
  let h: HttpHarness;
  let t: ReturnType<typeof treasuryHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof treasuryHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    t = treasuryHelpers(h);
    s = await t.setUp('Cheque Court');
  }, 90_000);

  afterAll(() => h.close());

  const receive = (unitId: string, over: Record<string, unknown> = {}) =>
    t.http('post', `/staff/units/${unitId}/cheques`, s.accountant.token, {
      number: `CQ${Math.floor(Math.random() * 1e6)}`,
      bankName: 'Misr Bank',
      amount: '400',
      dueOn: day(0),
      receivedOn: day(0),
      ...over,
    });
  const step = (id: string, what: string, body: object = {}) =>
    t.http(
      'post',
      `/staff/finance/cheques/${id}/${what}`,
      s.accountant.token,
      body,
    );
  const owed = async (unitId: string) =>
    (
      (
        await t
          .http('get', `/staff/units/${unitId}/statement`, s.accountant.token)
          .expect(200)
      ).body as { outstanding: string }
    ).outstanding;
  const bank = async () =>
    (
      await t
        .http(
          'get',
          `/staff/finance/cash-accounts/${s.bank.id}`,
          s.manager.token,
        )
        .expect(200)
    ).body as AccountBody;

  it('a cheque dated today pays at once; an office payment by cheque is in the register too', async () => {
    const unitId = await t.owingUnit(s);
    const c = (await receive(unitId).expect(201)).body as ChequeBody;
    expect(c).toMatchObject({ status: 'received', postDated: false });
    expect(c.paymentId).not.toBeNull();
    expect(await owed(unitId)).toBe('600.00');
    await t
      .http('post', `/staff/units/${unitId}/payments`, s.accountant.token, {
        amount: '100',
        method: 'cheque',
        reference: 'OFF-1',
        paidOn: day(0),
      })
      .expect(201);
    const listed = (
      await t
        .http(
          'get',
          `/staff/finance/cheques?unitId=${unitId}`,
          s.accountant.token,
        )
        .expect(200)
    ).body as { data: { number: string; status: string }[] };
    expect(listed.data.map((x) => x.number)).toContain('OFF-1');
  });

  it('a post-dated cheque is held: nothing paid, no invoice named, not deposited before its day', async () => {
    const unitId = await t.owingUnit(s);
    expect(
      err(await receive(unitId, { dueOn: day(10), invoiceIds: [] }).expect(400))
        .fields,
    ).toEqual([{ field: 'invoiceIds', code: 'FIELD_NOT_ALLOWED' }]);
    expect(
      err(
        await receive(unitId, { dueOn: day(10), amount: '1000.01' }).expect(
          409,
        ),
      ).code,
    ).toBe('PAYMENT_EXCEEDS_OUTSTANDING');
    const held = (await receive(unitId, { dueOn: day(10) }).expect(201))
      .body as ChequeBody;
    expect(held).toMatchObject({
      status: 'received',
      postDated: true,
      paymentId: null,
    });
    expect(await owed(unitId)).toBe('1000.00');
    expect(
      err(await step(held.id, 'deposit', { accountId: s.bank.id }).expect(409)),
    ).toMatchObject({
      code: 'CHEQUE_NOT_DUE',
      params: { dueOn: day(10) },
    });
  });

  it('its due day told once; deposited, it pays then; cleared, its money is in the bank', async () => {
    const unitId = await t.owingUnit(s);
    const held = (await receive(unitId, { dueOn: day(5) }).expect(201))
      .body as ChequeBody;
    await dueAlready(held.id);
    const sweep = h.moduleRef.get(ChequesService);
    expect(await sweep.tellDue()).toBeGreaterThanOrEqual(1);
    await sweep.tellDue();
    const told = await t.inTx(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'cheque.due', targetId: held.id },
      }),
    );
    expect(told.map((n) => n.accountId).sort()).toEqual(
      [s.manager.id, s.accountant.id].sort(),
    );
    expect(
      err(
        await step(held.id, 'deposit', { accountId: s.cashBox.id }).expect(409),
      ),
    ).toMatchObject({
      code: 'CASH_ACCOUNT_WRONG_KIND',
      params: { kind: 'bank' },
    });
    const deposited = (
      await step(held.id, 'deposit', { accountId: s.bank.id }).expect(201)
    ).body as ChequeBody;
    expect(deposited.status).toBe('deposited');
    expect(deposited.paymentId).not.toBeNull();
    expect(await owed(unitId)).toBe('600.00');
    expect((await bank()).pendingCheques).toBeGreaterThanOrEqual(1);
    const before = Number((await bank()).balance);
    expect(
      ((await step(held.id, 'clear').expect(201)).body as ChequeBody).status,
    ).toBe('cleared');
    expect(Number((await bank()).balance)).toBeCloseTo(before + 400, 2);
    expect(
      err(await step(held.id, 'bounce', { reasonCode: 'stopped' }).expect(409)),
    ).toMatchObject({
      code: 'CHEQUE_STATE',
      params: { status: 'cleared' },
    });
  });

  it('a bounced cheque reverses its payment: the unit owes again and is told', async () => {
    const unitId = await t.owingUnit(s);
    const c = (await receive(unitId).expect(201)).body as ChequeBody;
    await step(c.id, 'deposit', { accountId: s.bank.id }).expect(201);
    expect(await owed(unitId)).toBe('600.00');
    expect(
      err(await step(c.id, 'bounce', { reasonCode: 'nope' }).expect(400))
        .fields,
    ).toEqual([
      expect.objectContaining({
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
      }),
    ]);
    const bounced = (
      await step(c.id, 'bounce', { reasonCode: 'insufficient_funds' }).expect(
        201,
      )
    ).body as ChequeBody;
    expect(bounced).toMatchObject({ status: 'bounced', paymentReversed: true });
    expect(await owed(unitId)).toBe('1000.00');
    const reversal = await t.inTx(s.c, (tx) =>
      tx.financePayment.findFirstOrThrow({
        where: { reversesId: c.paymentId! },
      }),
    );
    expect(reversal.reasonCode).toBe('bounced_cheque');
    const told = await t.inTx(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'cheque.bounced', targetId: c.paymentId! },
      }),
    );
    expect(told.length).toBeGreaterThanOrEqual(1);
  });

  it('given back before it is deposited: its payment reversed; a held one simply returned', async () => {
    const unitId = await t.owingUnit(s);
    const paid = (await receive(unitId).expect(201)).body as ChequeBody;
    const back = (
      await step(paid.id, 'return', { reasonCode: 'replaced' }).expect(201)
    ).body as ChequeBody;
    expect(back).toMatchObject({ status: 'returned', paymentReversed: true });
    expect(await owed(unitId)).toBe('1000.00');
    const held = (await receive(unitId, { dueOn: day(20) }).expect(201))
      .body as ChequeBody;
    expect(
      (
        (
          await step(held.id, 'return', { reasonCode: 'payer_asked' }).expect(
            201,
          )
        ).body as ChequeBody
      ).status,
    ).toBe('returned');
    expect(
      err(await step(held.id, 'deposit', { accountId: s.bank.id }).expect(409))
        .code,
    ).toBe('CHEQUE_STATE');
  });

  it('a clear and a bounce at once: one wins, the other finds the cheque moved on', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const unitId = await t.owingUnit(s);
      const c = (await receive(unitId).expect(201)).body as ChequeBody;
      await step(c.id, 'deposit', { accountId: s.bank.id }).expect(201);
      const [cleared, bounced] = await Promise.all([
        step(c.id, 'clear'),
        step(c.id, 'bounce', { reasonCode: 'signature_mismatch' }),
      ]);
      expect([cleared.status, bounced.status].sort()).toEqual([201, 409]);
      const loser = [cleared, bounced].find((r) => r.status === 409)!;
      expect(err(loser).code).toBe('CHEQUE_STATE');
      const moved = await t.inTx(s.c, (tx) =>
        tx.financeCashMovement.count({ where: { chequeId: c.id } }),
      );
      const reversed = await t.inTx(s.c, (tx) =>
        tx.financePayment.count({ where: { reversesId: c.paymentId! } }),
      );
      // Cleared: its money in the bank, its payment kept; bounced: neither.
      expect([moved, reversed]).toEqual(
        cleared.status === 201 ? [1, 0] : [0, 1],
      );
    }
  });
});
