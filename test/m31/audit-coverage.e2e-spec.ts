import { AUDIT_ACTIONS } from '../../src/core/audit/actions';
import { addDays } from '../../src/core/common/slots/day-slots';
import { auditReaders } from '../setup/audit';
import { M31_COVERAGE } from '../setup/audit-coverage-split';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { clock, day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MARKER = 'AUDIT-m31-secret';

/**
 * One scenario per entry of ADR 0089's catalog: actor, target and metadata
 * — numbers, codes, ids, amounts and days; an invoice's note, a request's
 * note, a guarantee's issuer and reference, a payout's reference, a
 * transfer's reason and a variance's note as changed only.
 */
const covered = new Set<string>();

describe('Audit coverage — payables and commitments (ADR 0089)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;
  /** The bank account payouts leave (ADR 0085). */
  let bank: { id: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    read = auditReaders(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [
        { category: 'maintenance', amount: '500000.00' },
        { category: 'cleaning', amount: '100000.00' },
      ],
    );
    await f
      .http('patch', '/staff/governance/settings', s.manager.token, {
        items: [{ type: 'major_contract', threshold: '100000.00' }],
      })
      .expect(200);
    bank = (
      await f
        .http('post', '/staff/finance/cash-accounts', s.manager.token, {
          kind: 'bank',
          name: 'Coverage bank',
          openedOn: clock().today,
        })
        .expect(201)
    ).body as { id: string };
  }, 240_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const lineId = (c: string) => budget.lines.find((l) => l.category === c)!.id;
  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }
  const contract = async (over: object = {}) => {
    const vendorId = (
      (
        await f
          .http('post', '/staff/vendors', m(), {
            name: `Audit Payee ${uniqueSuffix()}`,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    return (
      (
        await f
          .http('post', '/maintenance/contracts', m(), {
            code: `AC-${uniqueSuffix()}`,
            kind: 'amc',
            vendorId,
            startsOn: budget.startsOn,
            endsOn: budget.endsOn,
            annualValue: '50000.00',
            budgetLineId: lineId('maintenance'),
            ...over,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  };
  const record = async (body: object) =>
    (
      (
        await f
          .http('post', '/staff/finance/vendor-invoices', acc(), {
            vendorNumber: `A-${uniqueSuffix()}`,
            issuedOn: clock().today,
            dueOn: day(5),
            invoiceFileId: await f.invoice(s.accountant),
            lines: [{ description: 'Work', amount: '1000.00' }],
            note: MARKER,
            ...body,
          })
          .expect(201)
      ).body as { id: string }
    ).id;

  it('budget_transfer.applied, .requested, .decided, .cancelled — lines and amounts; the reason as changed', async () => {
    const t = (
      await f
        .http('post', '/staff/finance/budget-transfers', acc(), {
          fromLineId: lineId('maintenance'),
          toLineId: lineId('cleaning'),
          amount: '1000.00',
          reason: MARKER,
        })
        .expect(201)
    ).body as { id: string };
    expect(await single('budget_transfer.applied', t.id)).toMatchObject({
      actorId: s.accountant.id,
      metadata: { amount: '1000.00', fromLineId: lineId('maintenance') },
    });
    const big = () =>
      f
        .http('post', '/staff/finance/budget-transfers', acc(), {
          fromLineId: lineId('maintenance'),
          toLineId: lineId('cleaning'),
          amount: '200000.00',
          reason: MARKER,
        })
        .expect(201);
    const a = (await big()).body as { id: string };
    expect(await single('budget_transfer.requested', a.id)).toMatchObject({
      changes: { reason: { changed: true } },
      metadata: { amount: '200000.00', limit: '100000.00' },
    });
    await f
      .http('post', `/staff/finance/budget-transfers/${a.id}/cancel`, acc())
      .expect(200);
    expect(await single('budget_transfer.cancelled', a.id)).toBeTruthy();
    const b = (await big()).body as { id: string };
    const r = await f.raise(s.accountant, {
      type: 'budget_transfer',
      budgetTransferId: b.id,
      cost: undefined,
    });
    await f.approve([s.owners[0], s.owners[1]], r.id);
    expect(await single('budget_transfer.decided', b.id)).toMatchObject({
      metadata: { requestId: r.id, status: 'applied' },
    });
  });

  it('budget.phased and budget_line.variance_explained — counts and codes; the note as changed', async () => {
    const line = budget.lines.find((l) => l.category === 'cleaning')!;
    await f
      .http('put', `/staff/finance/budgets/${budget.id}/months`, acc(), {
        lines: [
          {
            lineId: line.id,
            months: Array.from({ length: 12 }, (_, k) =>
              k === 11
                ? (Number(line.amount) - 11 * 1000).toFixed(2)
                : '1000.00',
            ),
          },
        ],
      })
      .expect(200);
    expect(await single('budget.phased', budget.id)).toMatchObject({
      metadata: { lines: 1 },
    });
    await f
      .http(
        'post',
        `/staff/finance/budget-lines/${line.id}/variance-reasons`,
        acc(),
        {
          month: 2,
          reasonCode: 'price_change',
          note: MARKER,
        },
      )
      .expect(204);
    expect(
      await single('budget_line.variance_explained', line.id),
    ).toMatchObject({
      metadata: { month: 2, reasonCode: 'price_change' },
      changes: { note: { changed: true } },
    });
  });

  it('finance_commitment.reserved and .released; vendor_invoice.recorded, .approved; vendor_payout.recorded', async () => {
    const c = await contract({ retentionPct: '5' });
    const pays = (
      (
        await f
          .http('put', `/maintenance/contracts/${c}/payments`, m(), {
            payments: [
              { dueOn: addDays(budget.startsOn, 20), amount: '1000.00' },
            ],
          })
          .expect(200)
      ).body as { data: { id: string }[] }
    ).data;
    const [commitment] = (
      (
        await f
          .http('get', '/staff/finance/commitments?open=true', acc())
          .expect(200)
      ).body as { data: { id: string; contractPaymentId: string }[] }
    ).data.filter((x) => x.contractPaymentId === pays[0].id);
    expect(
      await single('finance_commitment.reserved', commitment.id),
    ).toMatchObject({
      metadata: { source: 'contract', amount: '1000.00', itemId: pays[0].id },
    });
    const inv = await record({ contractId: c, contractPaymentId: pays[0].id });
    expect(await single('vendor_invoice.recorded', inv)).toMatchObject({
      actorId: s.accountant.id,
      changes: { note: { changed: true }, total: { to: '1000.00' } },
    });
    await f
      .http('post', `/staff/finance/vendor-invoices/${inv}/approve`, m(), {})
      .expect(200);
    expect(await single('vendor_invoice.approved', inv)).toMatchObject({
      actorId: s.manager.id,
      metadata: { total: '1000.00', commitmentId: commitment.id },
    });
    expect(
      await single('finance_commitment.released', commitment.id),
    ).toMatchObject({
      metadata: { reason: 'invoiced', amount: '1000.00', invoiceId: inv },
    });
    const paid = (
      await f
        .http('post', `/staff/finance/vendor-invoices/${inv}/pay`, acc(), {
          paidOn: clock().today,
          method: 'bank_transfer',
          reference: MARKER,
          cashAccountId: bank.id,
        })
        .expect(200)
    ).body as { payout: { id: string } };
    expect(
      await single('vendor_payout.recorded', paid.payout.id),
    ).toMatchObject({
      metadata: {
        kind: 'invoice',
        gross: '1000.00',
        retentionHeld: '50.00',
        net: '950.00',
        cashAccountId: bank.id,
      },
      changes: { reference: { changed: true } },
    });
  });

  it('vendor_invoice.rejected and .cancelled — codes', async () => {
    const c = await contract();
    const a = await record({ contractId: c });
    await f
      .http('post', `/staff/finance/vendor-invoices/${a}/reject`, m(), {
        reasonCode: 'wrong_amount',
      })
      .expect(200);
    expect(await single('vendor_invoice.rejected', a)).toMatchObject({
      metadata: { reasonCode: 'wrong_amount' },
    });
    const b = await record({ contractId: c });
    await f
      .http('post', `/staff/finance/vendor-invoices/${b}/cancel`, acc(), {
        reasonCode: 'vendor_withdrew',
      })
      .expect(200);
    expect(await single('vendor_invoice.cancelled', b)).toMatchObject({
      metadata: { reasonCode: 'vendor_withdrew', from: 'received' },
    });
  });

  it('contract_disbursement.requested, .approved, .rejected, .cancelled — kinds and amounts; the note as changed', async () => {
    const c = await contract();
    const ask = async () =>
      (
        (
          await f
            .http(
              'post',
              `/staff/finance/contract-payables/${c}/disbursements`,
              acc(),
              {
                kind: 'advance',
                amount: '1000.00',
                note: MARKER,
              },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
    const a = await ask();
    expect(await single('contract_disbursement.requested', a)).toMatchObject({
      changes: { note: { changed: true }, kind: { to: 'advance' } },
    });
    await f
      .http('post', `/staff/finance/contract-disbursements/${a}/approve`, m())
      .expect(200);
    expect(await single('contract_disbursement.approved', a)).toMatchObject({
      metadata: { kind: 'advance', amount: '1000.00' },
    });
    const b = await ask();
    await f
      .http('post', `/staff/finance/contract-disbursements/${b}/reject`, m(), {
        reasonCode: 'not_agreed',
      })
      .expect(200);
    expect(await single('contract_disbursement.rejected', b)).toMatchObject({
      metadata: { reasonCode: 'not_agreed' },
    });
    const d = await ask();
    await f
      .http(
        'post',
        `/staff/finance/contract-disbursements/${d}/cancel`,
        acc(),
        {
          reasonCode: 'not_needed',
        },
      )
      .expect(200);
    expect(await single('contract_disbursement.cancelled', d)).toMatchObject({
      metadata: { reasonCode: 'not_needed', from: 'requested' },
    });
  });

  it('vendor_guarantee.recorded, .returned, .called — the issuer and reference as changed', async () => {
    const c = await contract();
    const g = async () =>
      (
        (
          await f
            .http(
              'post',
              `/staff/finance/contract-payables/${c}/guarantees`,
              acc(),
              {
                kind: 'warranty',
                issuer: MARKER,
                reference: `${MARKER}-ref`.slice(0, 60),
                amount: '500.00',
                issuedOn: clock().today,
                expiresOn: day(200),
              },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
    const a = await g();
    expect(await single('vendor_guarantee.recorded', a)).toMatchObject({
      changes: { issuer: { changed: true }, reference: { changed: true } },
    });
    await f
      .http('post', `/staff/finance/vendor-guarantees/${a}/close`, m(), {
        outcome: 'returned',
      })
      .expect(200);
    expect(await single('vendor_guarantee.returned', a)).toMatchObject({
      metadata: { amount: '500.00' },
    });
    const b = await g();
    await f
      .http('post', `/staff/finance/vendor-guarantees/${b}/close`, m(), {
        outcome: 'called',
      })
      .expect(200);
    expect(await single('vendor_guarantee.called', b)).toBeTruthy();
  });

  it('covers every entry of its list, and the list names only catalog actions', () => {
    for (const k of M31_COVERAGE)
      expect(Object.keys(AUDIT_ACTIONS)).toContain(k);
    expect([...covered].sort()).toEqual([...M31_COVERAGE].sort());
  });
});
