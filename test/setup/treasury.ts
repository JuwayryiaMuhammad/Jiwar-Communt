import { day } from './compound-clock';
import { financeHelpers, type FinanceSetUp } from './finance';
import { fileHelpers } from './files';
import { gateHelpers } from './gate';
import type { HttpHarness } from './http-app';

export interface AccountBody {
  id: string;
  kind: string;
  balance: string;
  unmatchedLines: number;
  pendingCheques: number;
  retiredAt: string | null;
}

export interface HandinBody {
  id: string;
  number: string;
  status: string;
  expected: string;
  counted: string;
  variance: string;
  paymentCount: number;
  investigationId: string | null;
  payments: { paymentId: string }[];
}

export interface ChequeBody {
  id: string;
  status: string;
  paymentId: string | null;
  paymentReversed: boolean;
  postDated: boolean;
}

/**
 * Helpers for the treasury suites (ADR 0085): a compound with its manager
 * (who settles variances), its accountant (a cashier: records cash and
 * receives hand-ins), a collector, a cash box and a bank account; office
 * cash recorded by whoever is asked; a statement's CSV uploaded.
 */
export function treasuryHelpers(h: HttpHarness) {
  const f = financeHelpers(h);
  const files = fileHelpers(h);

  async function setUp(name = 'Treasury Court') {
    const s = await f.setUp(name);
    const g = gateHelpers(h);
    const collector = await f.who(
      s.c,
      (await g.guard(s.c, 'collector')).id,
      'staff',
    );
    const cashBox = await account(s.manager.token, {
      kind: 'cash',
      name: 'Office box',
    });
    const bank = await account(s.manager.token, {
      kind: 'bank',
      name: 'Main bank',
      bankName: 'National Bank',
      numberLast4: '1234',
    });
    return { ...s, collector, cashBox, bank };
  }

  async function account(
    token: string,
    body: Record<string, unknown>,
  ): Promise<AccountBody> {
    return (
      await f
        .http('post', '/staff/finance/cash-accounts', token, {
          openedOn: day(0),
          ...body,
        })
        .expect(201)
    ).body as AccountBody;
  }

  /** An invoice of `owes` on a new unit of building A: its id. */
  async function owingUnit(s: FinanceSetUp, owes = '1000'): Promise<string> {
    const home = await f.unit(s.c, 'A');
    await f.issue(s.accountant, home.id, {
      lines: [
        { descriptionEn: 'Dues', descriptionAr: 'مستحقات', amount: owes },
      ],
    });
    return home.id;
  }

  /** Office cash recorded by `token`'s account: the payment's id. */
  async function cash(
    token: string,
    unitId: string,
    amount: string,
  ): Promise<string> {
    const res = await f
      .http('post', `/staff/units/${unitId}/payments`, token, {
        amount,
        method: 'cash',
        paidOn: day(0),
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const handIn = (
    token: string,
    custodianId: string,
    body: Record<string, unknown>,
  ) =>
    f.http(
      'post',
      `/staff/finance/custody/${custodianId}/handins`,
      token,
      body,
    );

  /** A statement CSV uploaded and finalized by `token`: the file's id. */
  async function csv(token: string, text: string): Promise<string> {
    const id = await files.uploaded(
      token,
      'data_import',
      'text/csv',
      Buffer.from(text, 'utf8'),
    );
    await files.finalize(token, id).expect(200);
    return id;
  }

  return { ...f, setUp, account, owingUnit, cash, handIn, csv };
}
