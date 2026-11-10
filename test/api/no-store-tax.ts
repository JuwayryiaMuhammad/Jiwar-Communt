import type { Response } from 'supertest';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { day, dbDate } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { withholdingCertificateRow } from '../setup/tax-rows';
import { call, type Method } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of taxes (ADR 0093), in A, as its
 * manager. A's certificate is a raw row (a payout nothing else stands
 * behind); its VAT began two months back, that month closed in the ledger.
 */
export function taxCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as = (method: Method, path: string, body?: object) =>
    call(world(), method, path, {
      token: world().a.tokens.manager,
      ...(body ? { body } : {}),
    });
  const id = (res: Response) => (res.body as { id: string }).id;

  /** A vendor of A's, made once. */
  let vendor: Promise<string> | null = null;
  const aVendor = () =>
    (vendor ??= as('POST', '/staff/vendors', {
      name: `No-store tax payee ${uniqueSuffix()}`,
      categories: ['maintenance'],
    }).then(id));
  /** A bank account of A's, made once. */
  let bank: Promise<string> | null = null;
  const aBank = () =>
    (bank ??= as('POST', '/staff/finance/cash-accounts', {
      kind: 'bank',
      name: `No-store tax bank ${uniqueSuffix()}`,
      openingBalance: '100000.00',
      openedOn: day(0),
    }).then(id));
  const aCertificate = async () =>
    withholdingCertificateRow({
      tenantId: world().a.tenantId,
      vendorId: await aVendor(),
    });
  const quarter = () => {
    const [y, m] = day(0).split('-').map(Number);
    return `${y}-Q${Math.ceil(m / 3)}`;
  };
  const twoBack = () => monthBack(day(0), 2);

  return {
    'GET /staff/finance/tax/settings': () =>
      as('GET', '/staff/finance/tax/settings'),
    'PATCH /staff/finance/tax/settings': () =>
      as('PATCH', '/staff/finance/tax/settings', { suppliesRate: '1.00' }),
    'GET /staff/finance/tax/vendors': () =>
      as('GET', '/staff/finance/tax/vendors'),
    'PUT /staff/finance/tax/vendors/{id}': async () =>
      as('PUT', `/staff/finance/tax/vendors/${await aVendor()}`, {
        withholdingCategory: 'services',
      }),
    'GET /staff/finance/tax/vat/months': () =>
      as('GET', '/staff/finance/tax/vat/months'),
    // VAT registered since two months back, that month closed, then declared.
    'POST /staff/finance/tax/vat/declarations': async () => {
      await as('PATCH', '/staff/finance/tax/settings', {
        vatRegistered: true,
        vatNumber: `NS-${uniqueSuffix()}`,
      });
      await world().helpers.asManager(world().a, () =>
        world()
          .h.moduleRef.get(TenantTx)
          .withTenantTx((tx) =>
            tx.financeSettings.update({
              where: { tenantId: world().a.tenantId },
              data: { vatSince: dbDate(`${twoBack()}-01`) },
            }),
          ),
      );
      await as('POST', '/staff/finance/gl/periods/close', {
        month: twoBack(),
      });
      return as('POST', '/staff/finance/tax/vat/declarations', {
        month: twoBack(),
      });
    },
    'GET /staff/finance/tax/withholding/quarters': () =>
      as('GET', '/staff/finance/tax/withholding/quarters'),
    'GET /staff/finance/tax/withholding/certificates': () =>
      as('GET', '/staff/finance/tax/withholding/certificates'),
    'GET /staff/finance/tax/withholding/certificates/{id}': async () =>
      as(
        'GET',
        `/staff/finance/tax/withholding/certificates/${await aCertificate()}`,
      ),
    'GET /staff/finance/tax/withholding/certificates/{id}/pdf': async () =>
      as(
        'GET',
        `/staff/finance/tax/withholding/certificates/${await aCertificate()}/pdf`,
      ),
    'GET /staff/finance/tax/payments': () =>
      as('GET', '/staff/finance/tax/payments'),
    // The quarter's tax a certificate of today holds, paid in part.
    'POST /staff/finance/tax/payments': async () => {
      await aCertificate();
      return as('POST', '/staff/finance/tax/payments', {
        kind: 'withholding',
        quarter: quarter(),
        amount: '10.00',
        paidOn: day(0),
        method: 'bank_transfer',
        cashAccountId: await aBank(),
        reference: 'NS-1',
      });
    },
  };
}

/** `YYYY-MM`, `n` months before the day's. */
function monthBack(d: string, n: number): string {
  const [y, m] = d.split('-').map(Number);
  const k = y * 12 + (m - 1) - n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
}
