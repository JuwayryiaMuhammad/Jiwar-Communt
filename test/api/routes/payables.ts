import {
  DISBURSEMENT_KINDS,
  INVOICE_STATUSES,
} from '../../../src/finance/payables/payable-rules';
import type { Row } from '../registry';

/** Every payables response is `no-store` (docs/api/notes/payables.md). */
const manager = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  noStore: true,
  ...row,
});
const UNKNOWN = '00000000-0000-4000-8000-000000000089';
const invoiceBody = (over: object = {}) => ({
  vendorNumber: 'R-1',
  issuedOn: '2026-06-01',
  dueOn: '2026-06-30',
  invoiceFileId: UNKNOWN,
  lines: [{ description: 'Work', amount: '100.00' }],
  ...over,
});
const payBody = { paidOn: '2026-06-01', method: 'cash' };

/** Payables and commitments (ADR 0089). */
export const PAYABLES_ROUTES: Row[] = [
  // Budget planning: finance.budget.
  manager({
    method: 'POST',
    path: '/staff/finance/budget-transfers',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        fromLineId: w.bBudgetLineId,
        toLineId: UNKNOWN,
        amount: '1.00',
        reason: 'Foreign',
      }),
      code: 'BUDGET_LINE_NOT_FOUND',
    },
    invalid: {
      body: {
        fromLineId: UNKNOWN,
        toLineId: UNKNOWN,
        amount: '0',
        reason: 'x',
      },
      fields: [{ field: 'amount', code: 'INVALID_FORMAT' }],
    },
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/budget-transfers',
    foreign: 'none',
    invalid: {
      query: { budgetId: 'x' },
      fields: [{ field: 'budgetId', code: 'INVALID_UUID' }],
    },
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/budget-transfers/{id}',
    foreign: {
      params: (w) => ({ id: w.bBudgetTransferId }),
      code: 'BUDGET_TRANSFER_NOT_FOUND',
    },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/staff/finance/budget-transfers/{id}/cancel',
    foreign: {
      params: (w) => ({ id: w.bBudgetTransferId }),
      code: 'BUDGET_TRANSFER_NOT_FOUND',
    },
    invalid: 'none',
  }),
  manager({
    method: 'PUT',
    path: '/staff/finance/budgets/{id}/months',
    foreign: {
      params: (w) => ({ id: w.bBudgetId }),
      body: (w) => ({ lines: [{ lineId: w.bBudgetLineId, months: null }] }),
      code: 'BUDGET_NOT_FOUND',
    },
    invalid: {
      body: { lines: [{ lineId: 'x', months: null }] },
      fields: [{ field: 'lines.0.lineId', code: 'INVALID_UUID' }],
    },
  }),
  manager({
    method: 'POST',
    path: '/staff/finance/budget-lines/{id}/variance-reasons',
    foreign: {
      params: (w) => ({ id: w.bBudgetLineId }),
      body: () => ({ month: 1, reasonCode: 'timing' }),
      code: 'BUDGET_LINE_NOT_FOUND',
    },
    invalid: 'none',
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/variance-settings',
    foreign: 'none',
    invalid: 'none',
  }),
  manager({
    method: 'PATCH',
    path: '/staff/finance/variance-settings',
    foreign: 'none',
    invalid: 'none',
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/commitments',
    foreign: 'none',
    invalid: {
      query: { source: 'gift' },
      fields: [
        {
          field: 'source',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['contract', 'purchase_request', 'purchase_order'],
          },
        },
      ],
    },
  }),
  // Reports: finance.reports.
  manager({
    method: 'GET',
    path: '/staff/finance/reports/budget-periods',
    foreign: 'none',
    invalid: {
      query: { by: 'year' },
      fields: [
        {
          field: 'by',
          code: 'INVALID_VALUE',
          params: { allowed: ['month', 'quarter'] },
        },
      ],
    },
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/reports/budget-periods/export',
    foreign: 'none',
    invalid: {
      query: { by: 'year' },
      fields: [
        {
          field: 'by',
          code: 'INVALID_VALUE',
          params: { allowed: ['month', 'quarter'] },
        },
      ],
    },
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/reports/entries/export',
    foreign: 'none',
    invalid: {
      query: { from: '2026-02-30', to: '2026-13-01' },
      fields: [
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'to', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  // Vendors' invoices.
  manager({
    method: 'POST',
    path: '/staff/finance/vendor-invoices',
    foreign: {
      params: () => ({}),
      body: (w) => invoiceBody({ contractId: w.bContractId }),
      code: 'MAINTENANCE_CONTRACT_NOT_FOUND',
    },
    invalid: {
      body: invoiceBody({ vendorNumber: '', contractId: UNKNOWN }),
      fields: [
        {
          field: 'vendorNumber',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 60 },
        },
      ],
    },
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/vendor-invoices',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: INVOICE_STATUSES },
        },
      ],
    },
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/vendor-invoices/{id}',
    foreign: {
      params: (w) => ({ id: w.bVendorInvoiceId }),
      code: 'VENDOR_INVOICE_NOT_FOUND',
    },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/staff/finance/vendor-invoices/{id}/approve',
    foreign: {
      params: (w) => ({ id: w.bVendorInvoiceId }),
      body: () => ({}),
      code: 'VENDOR_INVOICE_NOT_FOUND',
    },
    invalid: {
      body: { budgetLineId: 'x' },
      fields: [{ field: 'budgetLineId', code: 'INVALID_UUID' }],
    },
  }),
  ...(['reject', 'cancel'] as const).map((tail) =>
    manager({
      method: 'POST',
      path: `/staff/finance/vendor-invoices/{id}/${tail}`,
      foreign: {
        params: (w) => ({ id: w.bVendorInvoiceId }),
        body: () => ({ reasonCode: 'other' }),
        code: 'VENDOR_INVOICE_NOT_FOUND',
      },
      invalid: 'none',
    }),
  ),
  manager({
    method: 'POST',
    path: '/staff/finance/vendor-invoices/{id}/pay',
    foreign: {
      params: (w) => ({ id: w.bVendorInvoiceId }),
      body: () => payBody,
      code: 'VENDOR_INVOICE_NOT_FOUND',
    },
    invalid: {
      body: { ...payBody, paidOn: '2026-02-30' },
      fields: [{ field: 'paidOn', code: 'INVALID_FORMAT' }],
    },
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/payment-schedule',
    foreign: 'none',
    invalid: {
      query: { from: '2026-02-30' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
  }),
  // A contract's money.
  manager({
    method: 'GET',
    path: '/staff/finance/contract-payables/{contractId}',
    foreign: {
      params: (w) => ({ contractId: w.bContractId }),
      code: 'MAINTENANCE_CONTRACT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/staff/finance/contract-payables/{contractId}/disbursements',
    foreign: {
      params: (w) => ({ contractId: w.bContractId }),
      body: () => ({ kind: 'advance', amount: '10.00' }),
      code: 'MAINTENANCE_CONTRACT_NOT_FOUND',
    },
    invalid: {
      body: { kind: 'gift', amount: '10.00' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: DISBURSEMENT_KINDS },
        },
      ],
    },
  }),
  manager({
    method: 'POST',
    path: '/staff/finance/contract-payables/{contractId}/guarantees',
    foreign: {
      params: (w) => ({ contractId: w.bContractId }),
      body: () => ({
        kind: 'performance',
        issuer: 'Bank',
        reference: 'G-1',
        amount: '10.00',
        issuedOn: '2026-06-01',
        expiresOn: '2027-06-01',
      }),
      code: 'MAINTENANCE_CONTRACT_NOT_FOUND',
    },
    invalid: {
      body: {
        kind: 'performance',
        issuer: 'Bank',
        reference: 'G-1',
        amount: '10.00',
        issuedOn: '2026-02-30',
        expiresOn: '2027-06-01',
      },
      fields: [{ field: 'issuedOn', code: 'INVALID_FORMAT' }],
    },
  }),
  manager({
    method: 'POST',
    path: '/staff/finance/vendor-guarantees/{id}/close',
    foreign: {
      params: (w) => ({ id: w.bGuaranteeId }),
      body: () => ({ outcome: 'returned' }),
      code: 'GUARANTEE_NOT_FOUND',
    },
    invalid: {
      body: { outcome: 'lost' },
      fields: [
        {
          field: 'outcome',
          code: 'INVALID_VALUE',
          params: { allowed: ['returned', 'called'] },
        },
      ],
    },
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/contract-disbursements',
    foreign: 'none',
    invalid: 'none',
  }),
  manager({
    method: 'GET',
    path: '/staff/finance/contract-disbursements/{id}',
    foreign: {
      params: (w) => ({ id: w.bDisbursementId }),
      code: 'DISBURSEMENT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  ...(['approve', 'reject', 'cancel', 'pay'] as const).map((tail) =>
    manager({
      method: 'POST',
      path: `/staff/finance/contract-disbursements/{id}/${tail}`,
      foreign: {
        params: (w) => ({ id: w.bDisbursementId }),
        ...(tail === 'pay'
          ? { body: () => payBody }
          : tail === 'approve'
            ? {}
            : { body: () => ({ reasonCode: 'other' }) }),
        code: 'DISBURSEMENT_NOT_FOUND',
      },
      invalid:
        tail === 'pay'
          ? {
              body: { ...payBody, method: 'gold' },
              fields: [
                {
                  field: 'method',
                  code: 'INVALID_VALUE',
                  params: { allowed: ['bank_transfer', 'cheque', 'cash'] },
                },
              ],
            }
          : 'none',
    }),
  ),
];
