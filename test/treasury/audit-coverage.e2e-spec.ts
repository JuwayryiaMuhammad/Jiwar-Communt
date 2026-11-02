import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { StatementsService } from '../../src/finance/treasury/statements.service';
import { auditReaders } from '../setup/audit';
import { M32_COVERAGE } from '../setup/audit-coverage-split';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  treasuryHelpers,
  type ChequeBody,
  type HandinBody,
} from '../setup/treasury';

/**
 * One scenario per entry of the treasury's catalog (ADR 0014, 0085): actor,
 * target and what changed — codes, ids, days and amounts; never a cheque's
 * number or a statement line's words.
 */
const covered = new Set<string>();
const NUMBER = 'AUDITQ777';
const WORDS = 'AUDIT-m32-secret';

describe('Audit coverage — treasury and custody', () => {
  let h: HttpHarness;
  let t: ReturnType<typeof treasuryHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof treasuryHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    t = treasuryHelpers(h);
    read = auditReaders(h);
    s = await t.setUp('Audit Treasury Court');
  }, 90_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(NUMBER);
    expect(text).not.toContain(WORDS);
    return rows[0];
  }

  it('cash_account.created / .updated / .retired', async () => {
    const a = await t.account(s.manager.token, {
      kind: 'cash',
      name: 'Audit box',
      openingBalance: '10',
    });
    expect(await single('cash_account.created', a.id)).toMatchObject({
      actorId: s.manager.id,
      metadata: { kind: 'cash', openingBalance: '10.00', openedOn: day(0) },
    });
    await t
      .http('patch', `/staff/finance/cash-accounts/${a.id}`, s.manager.token, {
        name: 'Audit box 2',
      })
      .expect(200);
    expect(await single('cash_account.updated', a.id)).toMatchObject({
      changes: { name: { from: 'Audit box', to: 'Audit box 2' } },
    });
    const adj = await t
      .http(
        'post',
        `/staff/finance/cash-accounts/${a.id}/adjustments`,
        s.manager.token,
        {
          amount: '-10',
          reasonCode: 'counting_correction',
          onDay: day(0),
        },
      )
      .expect(201);
    expect(
      await single('cash_adjustment.recorded', (adj.body as { id: string }).id),
    ).toMatchObject({
      metadata: {
        accountId: a.id,
        amount: '-10.00',
        reasonCode: 'counting_correction',
        onDay: day(0),
      },
    });
    await t
      .http(
        'post',
        `/staff/finance/cash-accounts/${a.id}/retire`,
        s.manager.token,
      )
      .expect(201);
    await single('cash_account.retired', a.id);
  });

  it('cash_transfer.recorded', async () => {
    const box = await t.account(s.manager.token, {
      kind: 'cash',
      name: 'Transfer audit',
      openingBalance: '50',
    });
    const res = await t
      .http('post', '/staff/finance/cash-transfers', s.accountant.token, {
        fromAccountId: box.id,
        toAccountId: s.bank.id,
        amount: '50',
        onDay: day(0),
      })
      .expect(201);
    expect(
      await single('cash_transfer.recorded', (res.body as { id: string }).id),
    ).toMatchObject({
      actorId: s.accountant.id,
      metadata: {
        fromAccountId: box.id,
        toAccountId: s.bank.id,
        amount: '50.00',
      },
    });
  });

  it('custody_handin.recorded / .resolved; custody_investigation.opened / .decided', async () => {
    const unitId = await t.owingUnit(s);
    await t.cash(s.accountant.token, unitId, '100');
    const h1 = (
      await t
        .handIn(s.manager.token, s.accountant.id, {
          cashAccountId: s.cashBox.id,
          expected: '100.00',
          counted: '90.00',
          varianceReason: 'missing_cash',
        })
        .expect(201)
    ).body as HandinBody;
    expect(await single('custody_handin.recorded', h1.id)).toMatchObject({
      actorId: s.manager.id,
      metadata: {
        custodianId: s.accountant.id,
        expected: '100.00',
        counted: '90.00',
        variance: '-10.00',
        varianceReason: 'missing_cash',
        paymentCount: 1,
      },
    });
    const opened = (
      await t
        .http(
          'post',
          `/staff/finance/custody-handins/${h1.id}/investigation`,
          s.manager.token,
          {
            ownerId: s.manager.id,
            dueOn: day(2),
          },
        )
        .expect(201)
    ).body as HandinBody;
    expect(
      await single('custody_investigation.opened', opened.investigationId!),
    ).toMatchObject({
      metadata: { handinId: h1.id, ownerId: s.manager.id, dueOn: day(2) },
    });
    await t
      .http(
        'post',
        `/staff/finance/custody-investigations/${opened.investigationId}/decide`,
        s.manager.token,
        {
          reasonCode: 'recovered',
          recoveredAmount: '10',
        },
      )
      .expect(201);
    expect(
      await single('custody_investigation.decided', opened.investigationId!),
    ).toMatchObject({
      metadata: { outcome: 'recovered', recovered: '10.00' },
    });
    expect(await single('custody_handin.resolved', h1.id)).toMatchObject({
      metadata: {
        outcome: 'recovered',
        investigationId: opened.investigationId,
      },
    });
  });

  it('cheque.received / .deposited / .cleared / .bounced / .returned — never the number', async () => {
    const receive = async (number: string) =>
      (
        await t
          .http(
            'post',
            `/staff/units/${await t.owingUnit(s)}/cheques`,
            s.accountant.token,
            {
              number,
              amount: '100',
              dueOn: day(0),
              receivedOn: day(0),
            },
          )
          .expect(201)
      ).body as ChequeBody;
    const a = await receive(NUMBER);
    expect(await single('cheque.received', a.id)).toMatchObject({
      metadata: {
        amount: '100.00',
        dueOn: day(0),
        postDated: false,
        paymentId: a.paymentId,
      },
    });
    await t
      .http(
        'post',
        `/staff/finance/cheques/${a.id}/deposit`,
        s.accountant.token,
        { accountId: s.bank.id },
      )
      .expect(201);
    expect(await single('cheque.deposited', a.id)).toMatchObject({
      metadata: { accountId: s.bank.id },
    });
    await t
      .http('post', `/staff/finance/cheques/${a.id}/clear`, s.accountant.token)
      .expect(201);
    expect(await single('cheque.cleared', a.id)).toMatchObject({
      metadata: { amount: '100.00' },
    });
    const b = await receive(`${NUMBER}B`);
    await t
      .http(
        'post',
        `/staff/finance/cheques/${b.id}/deposit`,
        s.accountant.token,
        { accountId: s.bank.id },
      )
      .expect(201);
    await t
      .http(
        'post',
        `/staff/finance/cheques/${b.id}/bounce`,
        s.accountant.token,
        { reasonCode: 'stopped' },
      )
      .expect(201);
    expect(await single('cheque.bounced', b.id)).toMatchObject({
      metadata: { reasonCode: 'stopped', paymentId: b.paymentId },
    });
    const c = await receive(`${NUMBER}C`);
    await t
      .http(
        'post',
        `/staff/finance/cheques/${c.id}/return`,
        s.accountant.token,
        { reasonCode: 'replaced' },
      )
      .expect(201);
    expect(await single('cheque.returned', c.id)).toMatchObject({
      metadata: { reasonCode: 'replaced' },
    });
  });

  it('statement_import.checked / .applied / .expired; statement_line.matched; statement_match.undone — never a line’s words', async () => {
    const text = (r: string) =>
      `date,amount,reference,description\r\n${day(0)},-4.00,${r},${WORDS}`;
    const upload = async (r: string) =>
      (
        await t
          .http(
            'post',
            `/staff/finance/cash-accounts/${s.bank.id}/statement-imports`,
            s.accountant.token,
            {
              fileId: await t.csv(s.accountant.token, text(r)),
            },
          )
          .expect(201)
      ).body as { id: string };
    const imp = await upload('AUD1');
    expect(await single('statement_import.checked', imp.id)).toMatchObject({
      metadata: {
        accountId: s.bank.id,
        rowCount: 1,
        newCount: 1,
        duplicateCount: 0,
        errorCount: 0,
      },
    });
    await t
      .http(
        'post',
        `/staff/finance/statement-imports/${imp.id}/apply`,
        s.accountant.token,
      )
      .expect(201);
    expect(await single('statement_import.applied', imp.id)).toMatchObject({
      metadata: { imported: 1, matched: 0 },
    });
    const line = (
      (
        await t
          .http(
            'get',
            `/staff/finance/statement-lines?accountId=${s.bank.id}&status=unmatched`,
            s.accountant.token,
          )
          .expect(200)
      ).body as { data: { id: string; reference: string }[] }
    ).data.find((l) => l.reference === 'AUD1')!;
    const matched = (
      await t
        .http(
          'post',
          `/staff/finance/statement-lines/${line.id}/match`,
          s.accountant.token,
          {
            kind: 'adjustment',
            reasonCode: 'bank_charge',
          },
        )
        .expect(201)
    ).body as { match: { id: string } };
    expect(
      await single('statement_line.matched', matched.match.id),
    ).toMatchObject({
      metadata: {
        lineId: line.id,
        kind: 'adjustment',
        auto: false,
        reasonCode: 'bank_charge',
      },
    });
    await t
      .http(
        'post',
        `/staff/finance/statement-matches/${matched.match.id}/undo`,
        s.accountant.token,
      )
      .expect(201);
    expect(
      await single('statement_match.undone', matched.match.id),
    ).toMatchObject({
      metadata: { lineId: line.id, kind: 'adjustment', reversed: true },
    });
    const stale = await upload('AUD2');
    await h.moduleRef
      .get(StatementsService)
      .expire(new Date(Date.now() + 25 * 3_600_000));
    await single('statement_import.expired', stale.id);
  });

  describe('catalog completeness', () => {
    it('every entry of the phase has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M32_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M32_COVERAGE].sort());
    });
  });
});
