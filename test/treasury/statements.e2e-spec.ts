import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  treasuryHelpers,
  type AccountBody,
  type ChequeBody,
} from '../setup/treasury';

const ROUNDS = 5;

interface ImportBody {
  id: string;
  status: string;
  rowCount: number;
  newCount: number;
  duplicateCount: number;
  errorCount: number;
  errors: { line: number; field: string; code: string }[];
  importedCount: number | null;
  matchedCount: number | null;
}

interface LineBody {
  id: string;
  amount: string;
  reference: string | null;
  match: {
    id: string;
    kind: string;
    targetId: string | null;
    auto: boolean;
  } | null;
}

/**
 * ADR 0085: a bank statement's CSV, checked (a dry run that says what is
 * new and what was imported before), then applied once within a day: new
 * lines imported, those naming exactly one bank transfer, cheque or
 * transfer leg matched on their own; the rest matched by hand or as an
 * adjustment. The same file twice imports nothing new. Two matches of one
 * line, or two lines of one target, at once: one wins.
 */
describe('Treasury — bank statements', () => {
  let h: HttpHarness;
  let t: ReturnType<typeof treasuryHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof treasuryHelpers>['setUp']>>;
  let n = 0;

  beforeAll(async () => {
    h = await createHttpHarness();
    t = treasuryHelpers(h);
    s = await t.setUp('Statement Court');
  }, 90_000);

  afterAll(() => h.close());

  const ref = () => `TRF-${Date.now() % 1e6}-${++n}`;
  const csv = (lines: string[]) =>
    ['date,amount,reference,description', ...lines].join('\r\n');
  const check = async (text: string, accountId = s.bank.id) =>
    t.http(
      'post',
      `/staff/finance/cash-accounts/${accountId}/statement-imports`,
      s.accountant.token,
      {
        fileId: await t.csv(s.accountant.token, text),
      },
    );
  const apply = (id: string) =>
    t.http(
      'post',
      `/staff/finance/statement-imports/${id}/apply`,
      s.accountant.token,
    );
  const lines = async (status?: string) =>
    (
      (
        await t
          .http(
            'get',
            `/staff/finance/statement-lines?accountId=${s.bank.id}${status ? `&status=${status}` : ''}&limit=100`,
            s.accountant.token,
          )
          .expect(200)
      ).body as { data: LineBody[] }
    ).data;
  const balance = async () =>
    Number(
      (
        (
          await t
            .http(
              'get',
              `/staff/finance/cash-accounts/${s.bank.id}`,
              s.manager.token,
            )
            .expect(200)
        ).body as AccountBody
      ).balance,
    );
  /** A bank transfer paid at the office for a new unit: its id. */
  const transfer = async (reference: string, amount = '250') => {
    const unitId = await t.owingUnit(s);
    const res = await t
      .http('post', `/staff/units/${unitId}/payments`, s.accountant.token, {
        amount,
        method: 'bank_transfer',
        reference,
        paidOn: day(0),
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };
  /** One fresh line imported, nothing matching it: its id. */
  const lone = async (amount: string) => {
    const r = ref();
    const imp = (
      await check(csv([`${day(0)},${amount},${r},Lone line`])).expect(201)
    ).body as ImportBody;
    await apply(imp.id).expect(201);
    return (await lines('unmatched')).find((l) => l.reference === r)!.id;
  };

  it('the dry run keeps what is wrong by line and column, never a cell; nothing is imported', async () => {
    const bad = (
      await check(
        csv([
          `${day(1)},10,A,x`,
          `2026-02-30,10,B,x`,
          `${day(0)},zero,C,x`,
          `${day(0)},0,D,x`,
        ]),
      ).expect(201)
    ).body as ImportBody;
    expect(bad).toMatchObject({
      status: 'invalid',
      rowCount: 4,
      errorCount: 4,
    });
    expect(bad.errors).toEqual([
      { line: 2, field: 'date', code: 'INVALID_VALUE' },
      { line: 3, field: 'date', code: 'INVALID_FORMAT' },
      { line: 4, field: 'amount', code: 'INVALID_FORMAT' },
      { line: 5, field: 'amount', code: 'INVALID_FORMAT' },
    ]);
    expect(err(await apply(bad.id).expect(409))).toMatchObject({
      code: 'STATEMENT_IMPORT_NOT_VALID',
      params: { status: 'invalid' },
    });
    const noHeader = (await check('when,amount\r\n2026-01-01,5').expect(201))
      .body as ImportBody;
    expect(noHeader.errors).toEqual([
      { line: 1, field: 'date', code: 'FIELD_REQUIRED' },
    ]);
    expect(err(await check('"open\r\n').expect(422)).code).toBe(
      'STATEMENT_IMPORT_UNREADABLE',
    );
    expect(
      err(await check(csv([`${day(0)},5,X,x`]), s.cashBox.id).expect(409)),
    ).toMatchObject({
      code: 'CASH_ACCOUNT_WRONG_KIND',
      params: { kind: 'bank' },
    });
  });

  it('applied once: a bank transfer by its reference matched on its own, the rest waiting; the same file again imports nothing', async () => {
    const r = ref();
    const paymentId = await transfer(r);
    const before = await balance();
    const text = csv([
      `${day(0)},250.00,${r},Transfer from a resident`,
      `${day(0)},-15.00,FEE,Bank charge`,
      `${day(0)},-15.00,FEE,Bank charge`,
    ]);
    const dry = (await check(text).expect(201)).body as ImportBody;
    expect(dry).toMatchObject({
      status: 'valid',
      rowCount: 3,
      newCount: 3,
      duplicateCount: 0,
    });
    const done = (await apply(dry.id).expect(201)).body as ImportBody;
    expect(done).toMatchObject({
      status: 'applied',
      importedCount: 3,
      matchedCount: 1,
    });
    expect(err(await apply(dry.id).expect(409)).code).toBe(
      'STATEMENT_IMPORT_NOT_VALID',
    );
    const matched = (await lines('matched')).find((l) => l.reference === r)!;
    expect(matched.match).toMatchObject({
      kind: 'payment',
      targetId: paymentId,
      auto: true,
    });
    expect(await balance()).toBeCloseTo(before + 250, 2);
    // Two identical lines of one file are two lines; the same file again is none.
    expect(
      (await lines('unmatched')).filter((l) => l.reference === 'FEE').length,
    ).toBeGreaterThanOrEqual(2);
    const again = (await check(text).expect(201)).body as ImportBody;
    expect(again).toMatchObject({ newCount: 0, duplicateCount: 3 });
    expect(
      ((await apply(again.id).expect(201)).body as ImportBody).importedCount,
    ).toBe(0);
  });

  it('matched by hand: an adjustment moves the money, an undo reverses it, once', async () => {
    const lineId = await lone('-7.25');
    const before = await balance();
    expect(
      err(
        await t
          .http(
            'post',
            `/staff/finance/statement-lines/${lineId}/match`,
            s.accountant.token,
            {
              kind: 'adjustment',
            },
          )
          .expect(400),
      ).code,
    ).toBe('REASON_REQUIRED');
    const matched = (
      await t
        .http(
          'post',
          `/staff/finance/statement-lines/${lineId}/match`,
          s.accountant.token,
          {
            kind: 'adjustment',
            reasonCode: 'bank_charge',
          },
        )
        .expect(201)
    ).body as LineBody;
    expect(matched.match).toMatchObject({ kind: 'adjustment', auto: false });
    expect(await balance()).toBeCloseTo(before - 7.25, 2);
    await t
      .http(
        'post',
        `/staff/finance/statement-matches/${matched.match!.id}/undo`,
        s.accountant.token,
      )
      .expect(201);
    expect(await balance()).toBeCloseTo(before, 2);
    expect(
      err(
        await t
          .http(
            'post',
            `/staff/finance/statement-matches/${matched.match!.id}/undo`,
            s.accountant.token,
          )
          .expect(409),
      ).code,
    ).toBe('STATEMENT_MATCH_UNDONE');
  });

  it('a deposited cheque matched is cleared; a target of another amount is refused', async () => {
    const unitId = await t.owingUnit(s);
    const c = (
      await t
        .http('post', `/staff/units/${unitId}/cheques`, s.accountant.token, {
          number: `Q${Date.now() % 1e6}`,
          amount: '320',
          dueOn: day(0),
          receivedOn: day(0),
        })
        .expect(201)
    ).body as ChequeBody;
    await t
      .http(
        'post',
        `/staff/finance/cheques/${c.id}/deposit`,
        s.accountant.token,
        { accountId: s.bank.id },
      )
      .expect(201);
    const wrong = await lone('321');
    const cands = (
      await t
        .http(
          'get',
          `/staff/finance/statement-lines/${wrong}/candidates`,
          s.accountant.token,
        )
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(cands.data.map((x) => x.id)).not.toContain(c.id);
    expect(
      err(
        await t
          .http(
            'post',
            `/staff/finance/statement-lines/${wrong}/match`,
            s.accountant.token,
            {
              kind: 'cheque',
              targetId: c.id,
            },
          )
          .expect(409),
      ),
    ).toMatchObject({
      code: 'MATCH_TARGET_INVALID',
      params: { why: 'amount' },
    });
    const right = await lone('320');
    const found = (
      await t
        .http(
          'get',
          `/staff/finance/statement-lines/${right}/candidates`,
          s.accountant.token,
        )
        .expect(200)
    ).body as { data: { id: string; kind: string }[] };
    expect(found.data).toContainEqual(
      expect.objectContaining({ kind: 'cheque', id: c.id }),
    );
    await t
      .http(
        'post',
        `/staff/finance/statement-lines/${right}/match`,
        s.accountant.token,
        {
          kind: 'cheque',
          targetId: c.id,
        },
      )
      .expect(201);
    const cheques = (
      await t
        .http(
          'get',
          `/staff/finance/cheques?unitId=${unitId}`,
          s.accountant.token,
        )
        .expect(200)
    ).body as { data: ChequeBody[] };
    expect(cheques.data[0].status).toBe('cleared');
  });

  describe('races', () => {
    it('two matches of one line at once: one is kept, the other finds it matched', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const lineId = await lone('-3');
        const go = () =>
          t.http(
            'post',
            `/staff/finance/statement-lines/${lineId}/match`,
            s.accountant.token,
            {
              kind: 'adjustment',
              reasonCode: 'bank_charge',
            },
          );
        const [a, b] = await Promise.all([go(), go()]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        expect(err([a, b].find((r) => r.status === 409)!).code).toBe(
          'STATEMENT_LINE_MATCHED',
        );
        const moved = await t.inTx(s.c, (tx) =>
          tx.financeCashMovement.count({
            where: { kind: 'adjustment', matchId: { not: null }, amount: -3 },
          }),
        );
        expect(moved).toBe(round + 1);
      }
    });

    it('two lines matched to one payment at once: one takes it', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const paymentId = await transfer(
          `NOREF-${round}-${Date.now() % 1e6}`,
          '41',
        );
        const one = await lone('41');
        const two = await lone('41');
        const go = (lineId: string) =>
          t.http(
            'post',
            `/staff/finance/statement-lines/${lineId}/match`,
            s.accountant.token,
            {
              kind: 'payment',
              targetId: paymentId,
            },
          );
        const [a, b] = await Promise.all([go(one), go(two)]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        expect(err([a, b].find((r) => r.status === 409)!).code).toBe(
          'MATCH_TARGET_TAKEN',
        );
      }
    });

    it('the same import applied twice at once: once', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const imp = (
          await check(csv([`${day(0)},-1.${round}0,${ref()},Twice`])).expect(
            201,
          )
        ).body as ImportBody;
        const [a, b] = await Promise.all([apply(imp.id), apply(imp.id)]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        expect(err([a, b].find((r) => r.status === 409)!).code).toBe(
          'STATEMENT_IMPORT_NOT_VALID',
        );
      }
    });
  });
});
