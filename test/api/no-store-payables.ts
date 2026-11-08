import type { Response } from 'supertest';
import { boardMatterHelpers } from '../setup/board-matters';
import { day, today } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { uniqueSuffix } from '../setup/fixtures';
import { activeBudget } from './no-store-board-matters';
import { call, type Method } from './request';
import type { World } from './world';

/** A setup call that must have done what it asked (awaited: a response). */
function done(res: Response, status = 201): Response {
  if (res.status !== status)
    throw new Error(`no-store: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/**
 * A real call for each payables route (ADR 0089), in A: every payables
 * response is no-store (docs/api/notes/payables.md). A's accountant records
 * and pays, A's manager approves, so nobody approves what they recorded; the
 * money sits on A's active budget, shared with the budget routes' calls.
 */
export function payableCalls(
  world: () => World,
  sitting: () => Promise<void>,
): Record<string, () => Promise<Response>> {
  const w = () => world();
  const budget = () => activeBudget(world, sitting);
  const manager = (method: Method, path: string, body?: object) =>
    call(w(), method, path, { token: w().a.tokens.manager, body });
  /** A's accountant, made once: a staff account of the `accountant` role. */
  let accountantToken: Promise<string> | null = null;
  const accToken = () =>
    (accountantToken ??= boardMatterHelpers(w().h)
      .accountant(w().a)
      .then((who) => who.token));
  const accountant = async (method: Method, path: string, body?: object) =>
    call(w(), method, path, { token: await accToken(), body });
  const id = (res: Response) => (res.body as { id: string }).id;
  const year = () => today().slice(0, 4);

  /** A bank account a payout leaves (ADR 0085: every payout names one). */
  let bank: Promise<string> | null = null;
  const aBank = () =>
    (bank ??= (async () =>
      id(
        done(
          await manager('POST', '/staff/finance/cash-accounts', {
            kind: 'bank',
            name: `No-store bank ${uniqueSuffix()}`,
            bankName: 'No-store Bank',
            numberLast4: '0089',
            openingBalance: '100000.00',
            openedOn: today(),
          }),
        ),
      ))());

  /** A vendor's contract on the budget's maintenance line, for the year. */
  let contract: Promise<string> | null = null;
  const aContract = () =>
    (contract ??= (async () => {
      const { lineId } = await budget();
      const vendorId = id(
        done(
          await manager('POST', '/staff/vendors', {
            name: `No-store payee ${uniqueSuffix()}`,
            categories: ['maintenance'],
          }),
        ),
      );
      return id(
        done(
          await manager('POST', '/maintenance/contracts', {
            code: `NS-${uniqueSuffix()}`,
            kind: 'amc',
            vendorId,
            startsOn: `${year()}-01-01`,
            endsOn: `${year()}-12-31`,
            annualValue: '60000.00',
            budgetLineId: lineId,
          }),
        ),
      );
    })());

  /** The vendor's invoice against the contract, recorded by the accountant. */
  const recordInvoice = async () =>
    accountant('POST', '/staff/finance/vendor-invoices', {
      contractId: await aContract(),
      vendorNumber: `NS-${uniqueSuffix()}`,
      issuedOn: today(),
      dueOn: day(10),
      invoiceFileId: await fileHelpers(w().h).ready(
        await accToken(),
        'expense_invoice',
        'application/pdf',
      ),
      lines: [{ description: 'No-store service', amount: '100.00' }],
    });
  const anInvoice = async () => id(done(await recordInvoice()));
  let firstInvoice: Promise<string> | null = null;
  const theInvoice = () => (firstInvoice ??= anInvoice());
  const anApprovedInvoice = async () => {
    const invoice = await anInvoice();
    done(
      await manager(
        'POST',
        `/staff/finance/vendor-invoices/${invoice}/approve`,
      ),
      200,
    );
    return invoice;
  };

  /** An advance asked by the accountant on the contract. */
  const anAdvance = async () =>
    id(
      done(
        await accountant(
          'POST',
          `/staff/finance/contract-payables/${await aContract()}/disbursements`,
          { kind: 'advance', amount: '100.00' },
        ),
      ),
    );
  let firstAdvance: Promise<string> | null = null;
  const theAdvance = () => (firstAdvance ??= anAdvance());

  /** A bank guarantee the vendor gave on the contract. */
  const guarantee = async () =>
    accountant(
      'POST',
      `/staff/finance/contract-payables/${await aContract()}/guarantees`,
      {
        kind: 'performance',
        issuer: 'No-store Bank',
        reference: `LG-${uniqueSuffix()}`,
        amount: '1000.00',
        issuedOn: today(),
        expiresOn: day(90),
      },
    );

  /** A transfer within the manager's limit: applied at once. */
  const transfer = async () => {
    const { lineId, otherLineId } = await budget();
    return manager('POST', '/staff/finance/budget-transfers', {
      fromLineId: lineId,
      toLineId: otherLineId,
      amount: '10.00',
      reason: 'No-store transfer',
    });
  };
  let firstTransfer: Promise<string> | null = null;
  const theTransfer = () =>
    (firstTransfer ??= (async () => id(done(await transfer())))());
  /**
   * A transfer above the manager's limit, left waiting for the board: the
   * limit is lowered for it and put back as it was.
   */
  const aWaitingTransfer = async () => {
    const { lineId, otherLineId } = await budget();
    const settings = done(
      await manager('GET', '/staff/governance/settings'),
      200,
    ).body as { items: { type: string; threshold: string | null }[] };
    const was =
      settings.items.find((s) => s.type === 'major_contract')?.threshold ??
      null;
    const limit = (threshold: string | null) =>
      manager('PATCH', '/staff/governance/settings', {
        items: [{ type: 'major_contract', threshold }],
      });
    done(await limit('50.00'), 200);
    try {
      return id(
        done(
          await manager('POST', '/staff/finance/budget-transfers', {
            fromLineId: lineId,
            toLineId: otherLineId,
            amount: '100.00',
            reason: 'No-store transfer for the board',
          }),
        ),
      );
    } finally {
      done(await limit(was), 200);
    }
  };

  return {
    // Budget planning: finance.budget.
    'POST /staff/finance/budget-transfers': () => transfer(),
    'GET /staff/finance/budget-transfers': async () => {
      await theTransfer();
      return manager(
        'GET',
        `/staff/finance/budget-transfers?budgetId=${(await budget()).budgetId}`,
      );
    },
    'GET /staff/finance/budget-transfers/{id}': async () =>
      manager('GET', `/staff/finance/budget-transfers/${await theTransfer()}`),
    'POST /staff/finance/budget-transfers/{id}/cancel': async () =>
      manager(
        'POST',
        `/staff/finance/budget-transfers/${await aWaitingTransfer()}/cancel`,
      ),
    'PUT /staff/finance/budgets/{id}/months': async () => {
      const { budgetId, otherLineId } = await budget();
      return manager('PUT', `/staff/finance/budgets/${budgetId}/months`, {
        lines: [{ lineId: otherLineId, months: null }],
      });
    },
    'POST /staff/finance/budget-lines/{id}/variance-reasons': async () => {
      const { otherLineId } = await budget();
      return manager(
        'POST',
        `/staff/finance/budget-lines/${otherLineId}/variance-reasons`,
        { month: 1, reasonCode: 'timing', note: 'No-store' },
      );
    },
    'GET /staff/finance/variance-settings': () =>
      manager('GET', '/staff/finance/variance-settings'),
    'PATCH /staff/finance/variance-settings': () =>
      manager('PATCH', '/staff/finance/variance-settings', {
        varianceReasonPct: 10,
      }),
    'GET /staff/finance/commitments': async () => {
      await aContract();
      return manager('GET', '/staff/finance/commitments');
    },
    'GET /staff/finance/reports/budget-periods': async () =>
      manager(
        'GET',
        `/staff/finance/reports/budget-periods?budgetId=${(await budget()).budgetId}`,
      ),
    'GET /staff/finance/reports/budget-periods/export': async () =>
      manager(
        'GET',
        `/staff/finance/reports/budget-periods/export?budgetId=${(await budget()).budgetId}`,
      ),
    'GET /staff/finance/reports/entries/export': () =>
      manager(
        'GET',
        `/staff/finance/reports/entries/export?from=${year()}-01-01&to=${today()}`,
      ),
    // Vendors' invoices: finance.payables records and pays,
    // finance.payables_approve approves.
    'POST /staff/finance/vendor-invoices': () => recordInvoice(),
    'GET /staff/finance/vendor-invoices': async () => {
      await theInvoice();
      return accountant('GET', '/staff/finance/vendor-invoices');
    },
    'GET /staff/finance/vendor-invoices/{id}': async () =>
      accountant('GET', `/staff/finance/vendor-invoices/${await theInvoice()}`),
    'POST /staff/finance/vendor-invoices/{id}/approve': async () =>
      manager(
        'POST',
        `/staff/finance/vendor-invoices/${await anInvoice()}/approve`,
      ),
    'POST /staff/finance/vendor-invoices/{id}/reject': async () =>
      manager(
        'POST',
        `/staff/finance/vendor-invoices/${await anInvoice()}/reject`,
        {
          reasonCode: 'wrong_amount',
        },
      ),
    'POST /staff/finance/vendor-invoices/{id}/cancel': async () =>
      accountant(
        'POST',
        `/staff/finance/vendor-invoices/${await anInvoice()}/cancel`,
        { reasonCode: 'entered_in_error' },
      ),
    'POST /staff/finance/vendor-invoices/{id}/pay': async () =>
      accountant(
        'POST',
        `/staff/finance/vendor-invoices/${await anApprovedInvoice()}/pay`,
        {
          paidOn: today(),
          method: 'bank_transfer',
          reference: 'NS-TRF',
          cashAccountId: await aBank(),
        },
      ),
    'GET /staff/finance/payment-schedule': async () => {
      await aContract();
      return accountant('GET', '/staff/finance/payment-schedule');
    },
    // A contract's money.
    'GET /staff/finance/contract-payables/{contractId}': async () =>
      accountant(
        'GET',
        `/staff/finance/contract-payables/${await aContract()}`,
      ),
    'POST /staff/finance/contract-payables/{contractId}/disbursements':
      async () =>
        accountant(
          'POST',
          `/staff/finance/contract-payables/${await aContract()}/disbursements`,
          { kind: 'advance', amount: '100.00' },
        ),
    'POST /staff/finance/contract-payables/{contractId}/guarantees': () =>
      guarantee(),
    // Returned or called by finance.payables_approve: the manager.
    'POST /staff/finance/vendor-guarantees/{id}/close': async () =>
      manager(
        'POST',
        `/staff/finance/vendor-guarantees/${id(done(await guarantee()))}/close`,
        { outcome: 'returned' },
      ),
    'GET /staff/finance/contract-disbursements': async () => {
      await theAdvance();
      return manager('GET', '/staff/finance/contract-disbursements');
    },
    'GET /staff/finance/contract-disbursements/{id}': async () =>
      manager(
        'GET',
        `/staff/finance/contract-disbursements/${await theAdvance()}`,
      ),
    'POST /staff/finance/contract-disbursements/{id}/approve': async () =>
      manager(
        'POST',
        `/staff/finance/contract-disbursements/${await anAdvance()}/approve`,
      ),
    'POST /staff/finance/contract-disbursements/{id}/reject': async () =>
      manager(
        'POST',
        `/staff/finance/contract-disbursements/${await anAdvance()}/reject`,
        { reasonCode: 'not_agreed' },
      ),
    'POST /staff/finance/contract-disbursements/{id}/cancel': async () =>
      accountant(
        'POST',
        `/staff/finance/contract-disbursements/${await anAdvance()}/cancel`,
        { reasonCode: 'not_needed' },
      ),
    'POST /staff/finance/contract-disbursements/{id}/pay': async () => {
      const advance = await anAdvance();
      done(
        await manager(
          'POST',
          `/staff/finance/contract-disbursements/${advance}/approve`,
        ),
        200,
      );
      return accountant(
        'POST',
        `/staff/finance/contract-disbursements/${advance}/pay`,
        { paidOn: today(), method: 'cheque', cashAccountId: await aBank() },
      );
    },
  };
}
