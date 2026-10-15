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
        dueOn: '2026-13-01',
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
];
