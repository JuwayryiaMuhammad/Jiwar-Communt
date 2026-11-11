import { ORDER_STATUSES } from '../../../src/maintenance/purchase-orders/purchase-order-rules';
import type { Row } from '../registry';

const UNKNOWN = '00000000-0000-4000-8000-000000000094';

/**
 * The orders’ routes (ADR 0094): a technician, who only asks to buy, is
 * denied; every response is no-store (a receipt carries signed photo links).
 */
const staff = (
  row: Omit<Row, 'auth' | 'as' | 'denied'> & { denied?: Row['denied'] },
): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  noStore: true,
  ...row,
});
/** A vendor’s contractor’s routes (ADR 0088): a staff technician is denied. */
const contractor = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'contractor',
  denied: 'technician',
  noStore: true,
  ...row,
});
const orderOf = (w: { bPurchaseOrderId: string }) => ({
  id: w.bPurchaseOrderId,
});
const notFound = 'PURCHASE_ORDER_NOT_FOUND';
const LINE = {
  kind: 'service',
  description: 'Work',
  quantity: '1',
  unit: 'lot',
  unitPrice: '10.00',
};
const badReason = {
  body: { reasonCode: ['x'] },
  fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
};
const invoiceOf = (w: { bVendorInvoiceId: string }) => ({
  id: w.bVendorInvoiceId,
});

/** Purchase orders, goods receipts and the three-way match (ADR 0094). */
export const PURCHASE_ORDER_ROUTES: Row[] = [
  staff({
    method: 'GET',
    path: '/staff/purchase-orders',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ORDER_STATUSES },
        },
      ],
    },
  }),
  staff({
    method: 'POST',
    path: '/staff/purchase-orders',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        tenderId: w.bTenderId,
        deliveryOn: '2099-01-01',
        lines: [LINE],
      }),
      code: 'TENDER_NOT_FOUND',
    },
    invalid: {
      body: { vendorId: 'x', deliveryOn: '2026-02-30', lines: [LINE] },
      fields: [
        { field: 'vendorId', code: 'INVALID_UUID' },
        { field: 'deliveryOn', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  staff({
    method: 'GET',
    path: '/staff/purchase-orders/{id}',
    foreign: { params: orderOf, code: notFound },
    invalid: 'none',
  }),
  staff({
    method: 'GET',
    path: '/staff/purchase-orders/{id}/pdf',
    foreign: { params: orderOf, code: notFound },
    invalid: 'none',
  }),
  staff({
    method: 'POST',
    path: '/staff/purchase-orders/{id}/approve',
    foreign: { params: orderOf, body: () => ({}), code: notFound },
    invalid: {
      body: { approvalRequestId: 'x' },
      fields: [{ field: 'approvalRequestId', code: 'INVALID_UUID' }],
    },
  }),
  staff({
    method: 'POST',
    path: '/staff/purchase-orders/{id}/reject',
    foreign: {
      params: orderOf,
      body: () => ({ reasonCode: 'no_budget' }),
      code: notFound,
    },
    invalid: badReason,
  }),
  staff({
    method: 'POST',
    path: '/staff/purchase-orders/{id}/amend',
    foreign: {
      params: orderOf,
      body: () => ({ reasonCode: 'price_change', lines: [LINE] }),
      code: notFound,
    },
    invalid: { ...badReason, body: { reasonCode: ['x'], lines: [LINE] } },
  }),
  staff({
    method: 'POST',
    path: '/staff/purchase-orders/{id}/withdraw-revision',
    foreign: { params: orderOf, code: notFound },
    invalid: 'none',
  }),
  staff({
    method: 'POST',
    path: '/staff/purchase-orders/{id}/cancel',
    foreign: {
      params: orderOf,
      body: () => ({ reasonCode: 'duplicate' }),
      code: notFound,
    },
    invalid: badReason,
  }),
  staff({
    method: 'POST',
    path: '/staff/purchase-orders/{id}/send',
    foreign: { params: orderOf, code: notFound },
    invalid: 'none',
  }),
  // Receiving: also who asks for a service confirms it, so only a role with
  // none of the three is denied.
  staff({
    method: 'POST',
    path: '/staff/purchase-orders/{id}/receipts',
    denied: 'collector',
    foreign: {
      params: orderOf,
      body: () => ({
        receivedOn: '2020-01-01',
        lines: [{ purchaseOrderLineId: UNKNOWN, accepted: '1' }],
      }),
      code: notFound,
    },
    invalid: {
      body: {
        receivedOn: '2026-02-30',
        storeId: 'x',
        lines: [{ purchaseOrderLineId: UNKNOWN, accepted: '1' }],
      },
      fields: [
        { field: 'receivedOn', code: 'INVALID_FORMAT' },
        { field: 'storeId', code: 'INVALID_UUID' },
      ],
    },
  }),
  // The vendor’s contractors.
  contractor({
    method: 'GET',
    path: '/contractor/purchase-orders',
    foreign: 'none',
    invalid: 'none',
  }),
  contractor({
    method: 'GET',
    path: '/contractor/purchase-orders/{id}',
    foreign: { params: orderOf, code: notFound },
    invalid: 'none',
  }),
  contractor({
    method: 'GET',
    path: '/contractor/purchase-orders/{id}/pdf',
    foreign: { params: orderOf, code: notFound },
    invalid: 'none',
  }),
  contractor({
    method: 'POST',
    path: '/contractor/purchase-orders/{id}/acknowledge',
    foreign: { params: orderOf, code: notFound },
    invalid: 'none',
  }),
  // The match and the settings: finance.
  staff({
    method: 'GET',
    path: '/staff/finance/vendor-invoices/{id}/match',
    foreign: { params: invoiceOf, code: 'VENDOR_INVOICE_NOT_FOUND' },
    invalid: 'none',
  }),
  staff({
    method: 'POST',
    path: '/staff/finance/vendor-invoices/{id}/match/override',
    foreign: {
      params: invoiceOf,
      body: () => ({ reasonCode: 'rounding' }),
      code: 'VENDOR_INVOICE_NOT_FOUND',
    },
    invalid: badReason,
  }),
  staff({
    method: 'GET',
    path: '/staff/finance/purchase-order-settings',
    foreign: 'none',
    invalid: 'none',
  }),
  staff({
    method: 'PATCH',
    path: '/staff/finance/purchase-order-settings',
    foreign: 'none',
    invalid: {
      body: {
        poRequiredAbove: '1.234',
        pricePct: 'x',
        quantityPct: '1000',
        amount: '-1',
      },
      fields: [
        { field: 'poRequiredAbove', code: 'INVALID_FORMAT' },
        { field: 'pricePct', code: 'INVALID_FORMAT' },
        { field: 'quantityPct', code: 'INVALID_FORMAT' },
        { field: 'amount', code: 'INVALID_FORMAT' },
      ],
    },
  }),
];
