import { newId } from '../../../src/core/common/uuid';
import { day } from '../../setup/compound-clock';
import type { Row } from '../registry';

/** Read with `finance.ledger`, which a technician never holds. */
const reader = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  noStore: true,
  ...row,
});
const LIMIT = { min: 1, max: 100 };
const CATEGORIES = ['supplies', 'services', 'professional', 'exempt'];

/**
 * Taxes (ADR 0093): the compound's VAT and withholding settings, its
 * vendors' withholding categories, the monthly VAT declaration, the
 * withholding certificates and quarters, and the taxes paid. Every
 * response no-store: the compound's books.
 */
export const TAX_ROUTES: Row[] = [
  reader({
    method: 'GET',
    path: '/staff/finance/tax/settings',
    foreign: 'none',
    invalid: 'none',
  }),
  reader({
    method: 'PATCH',
    path: '/staff/finance/tax/settings',
    foreign: 'none',
    invalid: {
      body: {
        vatRegistered: 'yes',
        vatRate: '14.123',
        taxableKinds: ['lunch'],
        withholdingThreshold: '-1',
      },
      fields: [
        { field: 'vatRegistered', code: 'INVALID_TYPE' },
        { field: 'vatRate', code: 'INVALID_FORMAT' },
        {
          field: 'taxableKinds',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'service_charge',
              'maintenance',
              'other',
              'facility',
              'club',
              'fine',
              'damage',
            ],
          },
        },
        { field: 'withholdingThreshold', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/tax/vendors',
    foreign: 'none',
    invalid: {
      query: { limit: '0' },
      fields: [{ field: 'limit', code: 'INVALID_NUMBER', params: LIMIT }],
    },
  }),
  reader({
    method: 'PUT',
    path: '/staff/finance/tax/vendors/{id}',
    foreign: {
      params: (w) => ({ id: w.bVendorId }),
      body: () => ({ withholdingCategory: 'services' }),
      code: 'VENDOR_NOT_FOUND',
    },
    invalid: {
      body: { withholdingCategory: 'gold' },
      fields: [
        {
          field: 'withholdingCategory',
          code: 'INVALID_VALUE',
          params: { allowed: CATEGORIES },
        },
      ],
    },
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/tax/vat/months',
    foreign: 'none',
    invalid: 'none',
  }),
  reader({
    method: 'POST',
    path: '/staff/finance/tax/vat/declarations',
    foreign: 'none',
    invalid: {
      body: { month: '2026-13' },
      fields: [{ field: 'month', code: 'INVALID_FORMAT' }],
    },
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/tax/withholding/quarters',
    foreign: 'none',
    invalid: 'none',
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/tax/withholding/certificates',
    foreign: 'none',
    invalid: {
      query: { quarter: '2026-Q5', vendorId: 'x', limit: '0' },
      fields: [
        { field: 'quarter', code: 'INVALID_FORMAT' },
        { field: 'vendorId', code: 'INVALID_UUID' },
        { field: 'limit', code: 'INVALID_NUMBER', params: LIMIT },
      ],
    },
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/tax/withholding/certificates/{id}',
    foreign: {
      params: (w) => ({ id: w.bWithholdingCertificateId }),
      code: 'WITHHOLDING_CERTIFICATE_NOT_FOUND',
    },
    invalid: 'none',
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/tax/withholding/certificates/{id}/pdf',
    foreign: {
      params: (w) => ({ id: w.bWithholdingCertificateId }),
      code: 'WITHHOLDING_CERTIFICATE_NOT_FOUND',
    },
    invalid: 'none',
  }),
  reader({
    method: 'GET',
    path: '/staff/finance/tax/payments',
    foreign: 'none',
    invalid: {
      query: { kind: 'rent', limit: '0' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['vat', 'withholding'] },
        },
        { field: 'limit', code: 'INVALID_NUMBER', params: LIMIT },
      ],
    },
  }),
  reader({
    method: 'POST',
    path: '/staff/finance/tax/payments',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        kind: 'vat',
        declarationId: w.bVatDeclarationId,
        amount: '1',
        paidOn: day(0),
        method: 'bank_transfer',
        cashAccountId: newId(),
      }),
      code: 'TAX_DECLARATION_NOT_FOUND',
    },
    invalid: {
      body: {
        kind: 'rent',
        declarationId: 'x',
        quarter: '2026-Q5',
        amount: '0',
        paidOn: '2026-02-30',
        method: 'barter',
        cashAccountId: 'y',
      },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['vat', 'withholding'] },
        },
        { field: 'declarationId', code: 'INVALID_UUID' },
        { field: 'quarter', code: 'INVALID_FORMAT' },
        { field: 'amount', code: 'INVALID_FORMAT' },
        { field: 'paidOn', code: 'INVALID_FORMAT' },
        {
          field: 'method',
          code: 'INVALID_VALUE',
          params: { allowed: ['bank_transfer', 'cheque', 'cash'] },
        },
        { field: 'cashAccountId', code: 'INVALID_UUID' },
      ],
    },
  }),
];
