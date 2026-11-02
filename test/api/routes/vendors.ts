import {
  VENDOR_CATEGORIES,
  VENDOR_DOCUMENT_KINDS,
} from '../../../src/maintenance/vendors/vendor-rules';
import { PURCHASE_STATUSES } from '../../../src/maintenance/purchases/purchase-rules';
import type { Row } from '../registry';

const manager = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  ...row,
});
/** Routes a technician may call too (they ask to buy): an owner is denied. */
const asker = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  ...manager(row),
  denied: 'owner',
});
const vendorFor = (w: { bVendorId: string }) => ({ id: w.bVendorId });

/** Vendors, compound contracts and purchase requests (ADR 0077). */
export const VENDOR_ROUTES: Row[] = [
  asker({
    method: 'GET',
    path: '/staff/vendors',
    foreign: 'none',
    invalid: {
      query: { status: 'gone', category: 'x' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['active', 'suspended'] },
        },
        {
          field: 'category',
          code: 'INVALID_VALUE',
          params: { allowed: VENDOR_CATEGORIES },
        },
      ],
    },
  }),
  manager({
    method: 'POST',
    path: '/staff/vendors',
    foreign: 'none',
    invalid: {
      body: { name: '', phone: 'call me', categories: [] },
      fields: [
        { field: 'name', code: 'INVALID_LENGTH', params: { min: 1, max: 120 } },
        { field: 'categories', code: 'INVALID_LENGTH', params: { min: 1 } },
        { field: 'phone', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  asker({
    method: 'GET',
    path: '/staff/vendors/{id}',
    foreign: { params: vendorFor, code: 'VENDOR_NOT_FOUND' },
    invalid: 'none',
  }),
  manager({
    method: 'PATCH',
    path: '/staff/vendors/{id}',
    foreign: {
      params: vendorFor,
      body: () => ({ notes: 'x' }),
      code: 'VENDOR_NOT_FOUND',
    },
    invalid: {
      body: { email: 'nope' },
      fields: [{ field: 'email', code: 'INVALID_EMAIL' }],
    },
  }),
  manager({
    method: 'POST',
    path: '/staff/vendors/{id}/suspend',
    foreign: {
      params: vendorFor,
      body: () => ({ reasonCode: 'performance' }),
      code: 'VENDOR_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  }),
  manager({
    method: 'POST',
    path: '/staff/vendors/{id}/reinstate',
    foreign: { params: vendorFor, code: 'VENDOR_NOT_FOUND' },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/staff/vendors/{id}/documents',
    foreign: {
      params: vendorFor,
      body: () => ({
        kind: 'licence',
        fileId: '0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e5f',
      }),
      code: 'VENDOR_NOT_FOUND',
    },
    invalid: {
      body: { kind: 'poem', fileId: 'x', expiresOn: '2027-02-30' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: VENDOR_DOCUMENT_KINDS },
        },
        { field: 'fileId', code: 'INVALID_UUID' },
        { field: 'expiresOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  manager({
    method: 'DELETE',
    path: '/staff/vendors/{id}/documents/{documentId}',
    foreign: {
      params: (w) => ({ id: w.bVendorId, documentId: w.bVendorId }),
      code: 'VENDOR_NOT_FOUND',
    },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/staff/vendors/{id}/evaluations',
    foreign: {
      params: vendorFor,
      body: () => ({
        quality: 3,
        timeliness: 3,
        cost: 3,
        communication: 3,
        safety: 3,
      }),
      code: 'VENDOR_NOT_FOUND',
    },
    invalid: {
      body: { quality: 0, timeliness: 6, cost: 3, communication: 3, safety: 3 },
      fields: [
        {
          field: 'quality',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 5 },
        },
        {
          field: 'timeliness',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 5 },
        },
      ],
    },
  }),
  manager({
    method: 'GET',
    path: '/staff/vendors/{id}/evaluations',
    foreign: { params: vendorFor, code: 'VENDOR_NOT_FOUND' },
    invalid: 'none',
  }),
  manager({
    method: 'POST',
    path: '/maintenance/contracts/{id}/renew',
    foreign: {
      params: (w) => ({ id: w.bContractId }),
      body: () => ({ code: 'RENEW-1', endsOn: '2031-12-31' }),
      code: 'MAINTENANCE_CONTRACT_NOT_FOUND',
    },
    invalid: {
      body: { code: '', endsOn: '2031-02-30' },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT' },
        { field: 'endsOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  manager({
    method: 'GET',
    path: '/maintenance/contracts/{id}/payments',
    foreign: {
      params: (w) => ({ id: w.bContractId }),
      code: 'MAINTENANCE_CONTRACT_NOT_FOUND',
    },
    invalid: 'none',
  }),
  manager({
    method: 'PUT',
    path: '/maintenance/contracts/{id}/payments',
    foreign: {
      params: (w) => ({ id: w.bContractId }),
      body: () => ({ payments: [] }),
      code: 'MAINTENANCE_CONTRACT_NOT_FOUND',
    },
    invalid: {
      body: { payments: [{ dueOn: '2031-02-30', amount: '-1' }] },
      fields: [
        { field: 'payments.0.dueOn', code: 'INVALID_FORMAT' },
        { field: 'payments.0.amount', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  manager({
    method: 'POST',
    path: '/maintenance/contracts/{id}/payments/{paymentId}/pay',
    foreign: {
      params: (w) => ({ id: w.bContractId, paymentId: w.bContractPaymentId }),
      body: () => ({ paidOn: '2026-06-01' }),
      code: 'MAINTENANCE_CONTRACT_NOT_FOUND',
    },
    invalid: {
      body: { paidOn: '2026-13-01' },
      fields: [{ field: 'paidOn', code: 'INVALID_FORMAT' }],
    },
  }),
  manager({
    method: 'GET',
    path: '/maintenance/contract-payments/due',
    foreign: 'none',
    invalid: {
      query: { from: '2026-13-01', to: 'x' },
      fields: [
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'to', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  asker({
    method: 'GET',
    path: '/staff/purchase-requests',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: PURCHASE_STATUSES },
        },
      ],
    },
  }),
  asker({
    method: 'POST',
    path: '/staff/purchase-requests',
    foreign: 'none',
    invalid: {
      body: { title: 'x', estimatedAmount: '0' },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 3, max: 200 },
        },
        { field: 'estimatedAmount', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  ...(['', '/approve', '/reject', '/cancel', '/fulfil'] as const).map((tail) =>
    (tail === '' || tail === '/cancel' ? asker : manager)({
      method: tail ? 'POST' : 'GET',
      path: `/staff/purchase-requests/{id}${tail}`,
      foreign: {
        params: (w) => ({ id: w.bPurchaseRequestId }),
        ...(tail === '/reject' || tail === '/cancel'
          ? { body: () => ({ reasonCode: 'not_needed' }) }
          : tail
            ? { body: () => ({}) }
            : {}),
        code: 'PURCHASE_REQUEST_NOT_FOUND',
      },
      invalid:
        tail === '/approve'
          ? {
              body: { approvalRequestId: 'x' },
              fields: [{ field: 'approvalRequestId', code: 'INVALID_UUID' }],
            }
          : 'none',
    }),
  ),
];
