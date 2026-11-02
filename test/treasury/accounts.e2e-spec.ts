import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { treasuryHelpers, type AccountBody } from '../setup/treasury';

/**
 * ADR 0085: the compound's bank and cash accounts are registers — a
 * balance is the sum of the movements, never stored. A transfer is two
 * legs; a cash box never goes below zero; an adjustment has its reason; a
 * retired account (at a zero balance only) takes nothing more.
 */
describe('Treasury — bank and cash accounts', () => {
  let h: HttpHarness;
  let t: ReturnType<typeof treasuryHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof treasuryHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    t = treasuryHelpers(h);
    s = await t.setUp('Accounts Court');
  }, 90_000);

  afterAll(() => h.close());

  const get = async (id: string) =>
    (
      await t
        .http('get', `/staff/finance/cash-accounts/${id}`, s.accountant.token)
        .expect(200)
    ).body as AccountBody;

  it('a cash box names no bank; an opening balance is its first movement; two live accounts never share a name', async () => {
    expect(
      err(
        await t
          .http('post', '/staff/finance/cash-accounts', s.manager.token, {
            kind: 'cash',
            name: 'Gate box',
            bankName: 'X',
            openedOn: day(0),
          })
          .expect(400),
      ).fields,
    ).toEqual([{ field: 'bankName', code: 'FIELD_NOT_ALLOWED' }]);
    const box = await t.account(s.accountant.token, {
      kind: 'cash',
      name: 'Gate box',
      openingBalance: '200.50',
    });
    expect(box).toMatchObject({ kind: 'cash', balance: '200.50' });
    const moves = await t
      .http(
        'get',
        `/staff/finance/cash-movements?accountId=${box.id}`,
        s.accountant.token,
      )
      .expect(200);
    expect(
      (moves.body as { data: { kind: string; amount: string }[] }).data,
    ).toEqual([expect.objectContaining({ kind: 'opening', amount: '200.50' })]);
    expect(
      err(
        await t
          .http('post', '/staff/finance/cash-accounts', s.manager.token, {
            kind: 'bank',
            name: 'gate BOX',
            openedOn: day(0),
          })
          .expect(409),
      ).code,
    ).toBe('DUPLICATE_RESOURCE');
    expect(
      err(
        await t
          .http('post', '/staff/finance/cash-accounts', s.manager.token, {
            kind: 'bank',
            name: 'Later',
            openedOn: day(1),
          })
          .expect(400),
      ).fields,
    ).toEqual([
      { field: 'openedOn', code: 'INVALID_VALUE', params: { max: day(0) } },
    ]);
  });

  it('a transfer is two legs; a cash box never goes below zero', async () => {
    const box = await t.account(s.manager.token, {
      kind: 'cash',
      name: 'Transfer box',
      openingBalance: '100',
    });
    const move = (amount: string) =>
      t.http('post', '/staff/finance/cash-transfers', s.accountant.token, {
        fromAccountId: box.id,
        toAccountId: s.bank.id,
        amount,
        onDay: day(0),
      });
    expect(err(await move('100.01').expect(409))).toMatchObject({
      code: 'CASH_ACCOUNT_INSUFFICIENT',
      params: { balance: '100.00' },
    });
    const done = (await move('60').expect(201)).body as {
      legs: { accountId: string; amount: string }[];
    };
    expect(done.legs).toEqual([
      expect.objectContaining({ accountId: box.id, amount: '-60.00' }),
      expect.objectContaining({ accountId: s.bank.id, amount: '60.00' }),
    ]);
    expect((await get(box.id)).balance).toBe('40.00');
    expect(
      err(
        await t
          .http('post', '/staff/finance/cash-transfers', s.accountant.token, {
            fromAccountId: box.id,
            toAccountId: box.id,
            amount: '1',
            onDay: day(0),
          })
          .expect(400),
      ).fields,
    ).toEqual([{ field: 'toAccountId', code: 'INVALID_VALUE' }]);
  });

  it('two transfers that fit alone but not together: one is recorded', async () => {
    const box = await t.account(s.manager.token, {
      kind: 'cash',
      name: 'Race box',
      openingBalance: '100',
    });
    for (let round = 0; round < 3; round++) {
      const move = () =>
        t.http('post', '/staff/finance/cash-transfers', s.accountant.token, {
          fromAccountId: box.id,
          toAccountId: s.bank.id,
          amount: '30',
          onDay: day(0),
        });
      await t
        .http(
          'post',
          `/staff/finance/cash-accounts/${box.id}/adjustments`,
          s.manager.token,
          {
            amount: '20',
            reasonCode: 'counting_correction',
            onDay: day(0),
          },
        )
        .expect(201);
      // As many of 30 as the box holds fit; one more never does.
      const balance = Number((await get(box.id)).balance);
      const n = Math.floor(balance / 30) + 1;
      const all = await Promise.all(Array.from({ length: n }, move));
      expect(all.filter((r) => r.status === 201)).toHaveLength(n - 1);
      expect(all.filter((r) => r.status === 409)).toHaveLength(1);
      expect(Number((await get(box.id)).balance)).toBeGreaterThanOrEqual(0);
    }
  });

  it('an adjustment has its reason code and moves either way', async () => {
    const res = await t
      .http(
        'post',
        `/staff/finance/cash-accounts/${s.bank.id}/adjustments`,
        s.accountant.token,
        {
          amount: '-12.50',
          reasonCode: 'nope',
          onDay: day(0),
        },
      )
      .expect(400);
    expect(err(res).fields).toEqual([
      expect.objectContaining({
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
      }),
    ]);
    const before = Number((await get(s.bank.id)).balance);
    await t
      .http(
        'post',
        `/staff/finance/cash-accounts/${s.bank.id}/adjustments`,
        s.accountant.token,
        {
          amount: '-12.50',
          reasonCode: 'bank_charge',
          onDay: day(0),
        },
      )
      .expect(201);
    expect(Number((await get(s.bank.id)).balance)).toBeCloseTo(
      before - 12.5,
      2,
    );
  });

  it('retired only at a zero balance, once; a retired account takes nothing', async () => {
    const box = await t.account(s.manager.token, {
      kind: 'cash',
      name: 'Retiring box',
      openingBalance: '5',
    });
    expect(
      err(
        await t
          .http(
            'post',
            `/staff/finance/cash-accounts/${box.id}/retire`,
            s.manager.token,
          )
          .expect(409),
      ),
    ).toMatchObject({
      code: 'CASH_ACCOUNT_NOT_EMPTY',
      params: { balance: '5.00', pendingCheques: 0 },
    });
    await t
      .http(
        'post',
        `/staff/finance/cash-accounts/${box.id}/adjustments`,
        s.manager.token,
        {
          amount: '-5',
          reasonCode: 'counting_correction',
          onDay: day(0),
        },
      )
      .expect(201);
    const retired = (
      await t
        .http(
          'post',
          `/staff/finance/cash-accounts/${box.id}/retire`,
          s.manager.token,
        )
        .expect(201)
    ).body as AccountBody;
    expect(retired.retiredAt).not.toBeNull();
    expect(
      err(
        await t
          .http(
            'post',
            `/staff/finance/cash-accounts/${box.id}/adjustments`,
            s.manager.token,
            {
              amount: '1',
              reasonCode: 'other',
              onDay: day(0),
            },
          )
          .expect(409),
      ).code,
    ).toBe('CASH_ACCOUNT_RETIRED');
    const live = (
      await t
        .http('get', '/staff/finance/cash-accounts', s.manager.token)
        .expect(200)
    ).body as { data: AccountBody[] };
    expect(live.data.map((a) => a.id)).not.toContain(box.id);
  });

  it('the accountant keeps the accounts; the collector and residents never', async () => {
    await t
      .http('get', '/staff/finance/cash-accounts', s.collector.token)
      .expect(403);
    await t
      .http('get', '/staff/finance/cash-accounts', s.owner.token)
      .expect(403);
  });
});
