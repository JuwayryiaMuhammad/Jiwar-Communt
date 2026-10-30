import { newId } from '../../../src/core/common/uuid';
import type { Row } from '../registry';

const CREDENTIALS = {
  mode: 'sandbox',
  secretKey: 'egy_sk_test_0123456789abcdef',
  publicKey: 'egy_pk_test_0123456789abcdef',
  hmacSecret: 'HMAC0123456789ABCDEF',
  cardIntegrationId: 4100001,
};

const BAD_CREDENTIALS: Pick<Row, 'invalid'> = {
  invalid: {
    body: { ...CREDENTIALS, secretKey: 'sk_live_x', cardIntegrationId: 0 },
    fields: [
      { field: 'secretKey', code: 'INVALID_FORMAT' },
      {
        field: 'cardIntegrationId',
        code: 'INVALID_NUMBER',
        params: { min: 1, max: 2147483647 },
      },
    ],
  },
};

/** The compound's online payment account (ADR 0046). */
export const FINANCE_GATEWAY_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/finance/gateway',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PUT',
    path: '/staff/finance/gateway',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    ...BAD_CREDENTIALS,
  },
  {
    method: 'PATCH',
    path: '/staff/finance/gateway',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { onlineEnabled: 'yes' },
      fields: [{ field: 'onlineEnabled', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/platform/tenants/{id}/payment-gateway',
    auth: 'platform',
    denied: 'restricted',
    foreign: { params: () => ({ id: newId() }), code: 'TENANT_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'PUT',
    path: '/platform/tenants/{id}/payment-gateway',
    auth: 'platform',
    denied: 'restricted',
    foreign: {
      params: () => ({ id: newId() }),
      body: () => CREDENTIALS,
      code: 'TENANT_NOT_FOUND',
    },
    ...BAD_CREDENTIALS,
  },
  {
    method: 'PATCH',
    path: '/platform/tenants/{id}/payment-gateway',
    auth: 'platform',
    denied: 'restricted',
    foreign: {
      params: () => ({ id: newId() }),
      body: () => ({ platformDisabled: true }),
      code: 'TENANT_NOT_FOUND',
    },
    invalid: {
      body: { platformDisabled: 1 },
      fields: [{ field: 'platformDisabled', code: 'INVALID_TYPE' }],
    },
  },
];

const LINES = [
  {
    descriptionEn: 'Service charge',
    descriptionAr: 'رسوم الخدمات',
    amount: '1000',
  },
];
const STATUS_ALLOWED = [
  'unpaid',
  'partially_paid',
  'overdue',
  'paid',
  'credited',
  'rescheduled',
  'open',
];

/** Invoices and credit notes (ADR 0046). */
export const FINANCE_INVOICE_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/staff/invoices',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        target: 'street',
        kind: 'rent',
        dueOn: '2026-02-30',
        lines: LINES,
      },
      fields: [
        {
          field: 'target',
          code: 'INVALID_VALUE',
          params: { allowed: ['unit', 'building', 'all'] },
        },
        { field: 'kind', code: 'INVALID_VALUE' },
        { field: 'dueOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/invoice-batches/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInvoiceBatchId }),
      code: 'INVOICE_BATCH_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/invoices',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'late' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: STATUS_ALLOWED },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/invoices/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInvoiceId }),
      code: 'INVOICE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/invoices/{id}/credit-notes',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInvoiceId }),
      body: () => ({ amount: '10', reasonCode: 'waiver' }),
      code: 'INVOICE_NOT_FOUND',
    },
    invalid: {
      body: { amount: '0', reasonCode: 'waiver' },
      fields: [{ field: 'amount', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'GET',
    path: '/units/{unitId}/invoices',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { status: 'late' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: STATUS_ALLOWED },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/invoices/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInvoiceId }),
      code: 'INVOICE_NOT_FOUND',
    },
    invalid: 'none',
  },
  // What a unit will owe (ADR 0069).
  {
    method: 'GET',
    path: '/units/{unitId}/upcoming-dues',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { months: '9' },
      fields: [
        {
          field: 'months',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 6 },
        },
      ],
    },
  },
  // Payment plans residents ask for (ADR 0069).
  {
    method: 'POST',
    path: '/invoices/{id}/plan-requests',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInvoiceId }),
      body: () => ({ months: 3 }),
      code: 'INVOICE_NOT_FOUND',
    },
    invalid: {
      body: { months: 30 },
      fields: [
        {
          field: 'months',
          code: 'INVALID_NUMBER',
          params: { min: 2, max: 24 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/plan-requests/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPlanRequestId }),
      code: 'PLAN_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/plan-requests/{id}/withdraw',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPlanRequestId }),
      code: 'PLAN_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/plan-requests',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'open' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['pending', 'accepted', 'declined', 'withdrawn', 'lapsed'],
          },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/plan-requests/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPlanRequestId }),
      code: 'PLAN_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/plan-requests/{id}/accept',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPlanRequestId }),
      body: () => ({
        instalments: [
          { dueOn: '2099-01-01', amount: '1' },
          { dueOn: '2099-02-01', amount: '1' },
        ],
      }),
      code: 'PLAN_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/plan-requests/{id}/decline',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPlanRequestId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'PLAN_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/finance/plan-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/staff/finance/plan-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { planMaxMonths: 1 },
      fields: [
        {
          field: 'planMaxMonths',
          code: 'INVALID_NUMBER',
          params: { min: 2, max: 24 },
        },
      ],
    },
  },
  // A receipt's PDF (ADR 0069), drawn on demand.
  {
    method: 'GET',
    path: '/payments/{id}/receipt',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFinancePaymentId }),
      code: 'PAYMENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/payments/{id}/receipt',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFinancePaymentId }),
      code: 'PAYMENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  // Where the fees went (ADR 0069): whoever sees some unit's money.
  {
    method: 'GET',
    path: '/finance/spending-reports',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/finance/spending-reports/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bSpendingReportId }),
      code: 'SPENDING_REPORT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/finance/spending-reports',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/finance/spending-reports',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: () => ({}),
      body: (w) => ({ budgetId: w.bBudgetId }),
      code: 'BUDGET_NOT_FOUND',
    },
    invalid: {
      body: { summaryEn: '' },
      fields: [
        {
          field: 'summaryEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
  },
  // Fee transparency (ADR 0069).
  {
    method: 'GET',
    path: '/units/{unitId}/fees',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/invoices/{id}/comparison',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInvoiceId }),
      code: 'INVOICE_NOT_FOUND',
    },
    invalid: 'none',
  },
];

/** Instalment plans (ADR 0048). */
export const FINANCE_INSTALMENT_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/staff/invoices/{id}/instalment-plan',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInvoiceId }),
      body: () => ({
        instalments: [
          { dueOn: '2099-01-01', amount: '10' },
          { dueOn: '2099-02-01', amount: '10' },
        ],
      }),
      code: 'INVOICE_NOT_FOUND',
    },
    invalid: {
      body: { instalments: [{ dueOn: '2027-02-29', amount: '0' }] },
      fields: [
        {
          field: 'instalments',
          code: 'INVALID_LENGTH',
          params: { min: 2, max: 24 },
        },
        { field: 'instalments.0.dueOn', code: 'INVALID_FORMAT' },
        { field: 'instalments.0.amount', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/instalment-plans',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'late' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['active', 'settled', 'cancelled'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/instalment-plans/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInstalmentPlanId }),
      code: 'INSTALMENT_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/instalment-plans/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInstalmentPlanId }),
      body: () => ({ dueOn: '2099-01-01' }),
      code: 'INSTALMENT_PLAN_NOT_FOUND',
    },
    invalid: {
      body: { dueOn: '2026-04-31' },
      fields: [{ field: 'dueOn', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'GET',
    path: '/instalment-plans/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInstalmentPlanId }),
      code: 'INSTALMENT_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
];

/** Invoice disputes (ADR 0048): the opener's words travel, so no-store. */
export const FINANCE_DISPUTE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/invoice-disputes',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'pending' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'accepted', 'rejected'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/invoice-disputes/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bDisputeId }),
      code: 'DISPUTE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/invoice-disputes/{id}/decide',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bDisputeId }),
      body: () => ({ decision: 'reject', reasonCode: 'other' }),
      code: 'DISPUTE_NOT_FOUND',
    },
    invalid: {
      body: { decision: 'maybe' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['accept', 'reject'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/invoices/{id}/disputes',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInvoiceId }),
      body: () => ({ reasonCode: 'wrong_amount' }),
      code: 'INVOICE_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 'wrong_amount', text: '', photoFileId: 'x' },
      fields: [
        {
          field: 'text',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
        { field: 'photoFileId', code: 'INVALID_UUID' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/invoices/{id}/disputes',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bInvoiceId }),
      code: 'INVOICE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/invoice-disputes/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bDisputeId }),
      code: 'DISPUTE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/** Refunds of a unit's credit (ADR 0048): the manager's, after a step-up. */
export const FINANCE_REFUND_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/staff/units/{unitId}/refunds',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({ amount: '1', channel: 'cash', refundedOn: '2099-01-01' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { amount: '1', channel: 'cheque', refundedOn: '2026-13-01' },
      fields: [
        { field: 'channel', code: 'INVALID_VALUE' },
        { field: 'refundedOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/refunds/{id}/reverse',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRefundId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'REFUND_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 3 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/refunds',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { from: '2026-02-30', to: '2027-02-29' },
      fields: [
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'to', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/refunds/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRefundId }),
      code: 'REFUND_NOT_FOUND',
    },
    invalid: 'none',
  },
];

const BAD_PERIOD: Pick<Row, 'invalid'> = {
  invalid: {
    query: { from: '2026-04-31', to: '2026-02-30' },
    fields: [
      { field: 'from', code: 'INVALID_FORMAT' },
      { field: 'to', code: 'INVALID_FORMAT' },
    ],
  },
};

/**
 * The ledger and the finance reports (ADR 0048), each with a CSV twin: the
 * downloads are no-store.
 */
export const FINANCE_REPORT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/finance/ledger',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    ...BAD_PERIOD,
  },
  {
    method: 'GET',
    path: '/staff/finance/ledger/export',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    ...BAD_PERIOD,
    noStore: true,
  },
  ...(['aging', 'outstanding'] as const).flatMap((name): Row[] =>
    [false, true].map((exported) => ({
      method: 'GET',
      path: `/staff/finance/reports/${name}${exported ? '/export' : ''}`,
      auth: 'tenant',
      as: 'manager',
      denied: 'guard',
      foreign: 'none',
      invalid: {
        query: { groupBy: 'floor' },
        fields: [
          {
            field: 'groupBy',
            code: 'INVALID_VALUE',
            params: { allowed: ['unit', 'building'] },
          },
        ],
      },
      ...(exported ? { noStore: true } : {}),
    })),
  ),
  ...[false, true].map((exported): Row => ({
    method: 'GET',
    path: `/staff/finance/reports/collections${exported ? '/export' : ''}`,
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    ...BAD_PERIOD,
    ...(exported ? { noStore: true } : {}),
  })),
  ...[false, true].map((exported): Row => ({
    method: 'GET',
    path: `/staff/finance/reports/daily-cash${exported ? '/export' : ''}`,
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { day: '2027-02-29' },
      fields: [{ field: 'day', code: 'INVALID_FORMAT' }],
    },
    ...(exported ? { noStore: true } : {}),
  })),
];

const PLAN = {
  nameEn: 'Service charge',
  nameAr: 'رسوم الخدمات',
  kind: 'service_charge',
  frequency: 'monthly',
  amount: '1500',
  startsOn: '2099-01-01',
  issueDaysBefore: 0,
  dueDaysAfterIssue: 10,
};

/** Billing plans and their per-unit terms (ADR 0046). */
export const FINANCE_BILLING_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/billing-plans',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/billing-plans',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { ...PLAN, frequency: 'weekly', startsOn: '2026-11-02' },
      fields: [
        { field: 'frequency', code: 'INVALID_VALUE' },
        { field: 'startsOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/billing-plans/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBillingPlanId }),
      code: 'BILLING_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/staff/billing-plans/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBillingPlanId }),
      body: () => ({ active: true }),
      code: 'BILLING_PLAN_NOT_FOUND',
    },
    invalid: {
      body: { issueDaysBefore: 29 },
      fields: [
        {
          field: 'issueDaysBefore',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 28 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/billing-plans/{id}/amount-changes',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBillingPlanId }),
      code: 'BILLING_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/billing-plans/{id}/overrides',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBillingPlanId }),
      code: 'BILLING_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'PUT',
    path: '/staff/billing-plans/{id}/overrides/{unitId}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBillingPlanId, unitId: w.a.homeUnitId }),
      body: () => ({ amount: '100' }),
      code: 'BILLING_PLAN_NOT_FOUND',
    },
    invalid: {
      body: { amount: '-1' },
      fields: [{ field: 'amount', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'DELETE',
    path: '/staff/billing-plans/{id}/overrides/{unitId}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBillingPlanId, unitId: w.a.homeUnitId }),
      code: 'BILLING_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
];

/** Payments, receipts and statements (ADR 0046). */
export const FINANCE_PAYMENT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/payments',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { channel: 'post', from: '2026-04-31', to: '2026-13-01' },
      fields: [
        { field: 'channel', code: 'INVALID_VALUE' },
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'to', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/payments/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFinancePaymentId }),
      code: 'PAYMENT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/units/{unitId}/payments',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({ amount: '10', method: 'cash', paidOn: '2026-10-15' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { amount: '10', method: 'card', paidOn: '2026-02-30' },
      fields: [
        {
          field: 'method',
          code: 'INVALID_VALUE',
          params: { allowed: ['cash', 'bank_transfer', 'cheque'] },
        },
        { field: 'paidOn', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/payments/{id}/reverse',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFinancePaymentId }),
      body: () => ({ reasonCode: 'duplicate' }),
      code: 'PAYMENT_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/units/{unitId}/statement',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/units/{unitId}/payments',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/payments/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFinancePaymentId }),
      code: 'PAYMENT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/units/{unitId}/statement',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
];

/** Paying online (ADR 0046). */
export const FINANCE_ONLINE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/finance/gateway-events',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { outcome: 'lost' },
      fields: [
        {
          field: 'outcome',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'applied',
              'duplicate',
              'failed_attempt',
              'not_final',
              'verification_pending',
              'contradicted',
              'order_mismatch',
              'amount_mismatch',
              'unknown_reference',
            ],
          },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/units/{unitId}/payment-sessions',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({}),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { invoiceIds: 'all' },
      fields: [{ field: 'invoiceIds', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/payment-sessions/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPaymentSessionId }),
      code: 'PAYMENT_SESSION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/** The public receipt page (ADR 0046). */
export const FINANCE_PUBLIC_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/public/receipts/lookup',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { code: '' },
      fields: [
        { field: 'code', code: 'INVALID_LENGTH', params: { min: 1, max: 64 } },
      ],
    },
    noStore: true,
  },
];
