import type { Row } from '../registry';

/** A ticket's costs (ADR 0065): dispatch's. */
export const COST_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/maintenance/tickets/{id}/costs',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: { params: (w) => ({ id: w.bTicketId }), code: 'TICKET_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/costs',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({
        kind: 'labour',
        description: 'Two hours',
        quantity: '2',
        unitAmount: '80',
      }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { kind: 'part', description: '', quantity: '0', unitAmount: '-1' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['labour', 'contractor', 'other'] },
        },
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
        { field: 'quantity', code: 'INVALID_FORMAT' },
        { field: 'unitAmount', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/ticket-costs/{id}/void',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bCostEntryId }),
      body: () => ({ reasonCode: 'duplicate' }),
      code: 'TICKET_COST_ENTRY_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];

/** The technician's suggested quotes, and dispatch's decision (ADR 0065). */
export const QUOTE_SUGGESTION_ROUTES: Row[] = [
  ...(['technician', 'manager'] as const).map((as): Row => ({
    method: 'GET',
    path:
      as === 'technician'
        ? '/technician/tickets/{id}/quote-suggestions'
        : '/maintenance/tickets/{id}/quote-suggestions',
    auth: 'tenant',
    as,
    denied: as === 'technician' ? 'manager' : 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: 'none',
  })),
  {
    method: 'POST',
    path: '/technician/tickets/{id}/quote-suggestions',
    auth: 'tenant',
    as: 'technician',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ amount: '300' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { amount: '0', note: '' },
      fields: [
        { field: 'amount', code: 'INVALID_FORMAT' },
        {
          field: 'note',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/quote-suggestions/{id}/send',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bQuoteSuggestionId }),
      body: () => ({}),
      code: 'QUOTE_SUGGESTION_NOT_FOUND',
    },
    invalid: {
      body: { amount: 'x' },
      fields: [{ field: 'amount', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/quote-suggestions/{id}/dismiss',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bQuoteSuggestionId }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'QUOTE_SUGGESTION_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];

const UNITS = [
  'piece',
  'metre',
  'litre',
  'kilogram',
  'box',
  'set',
  'pair',
  'roll',
];
const PART_STATUSES = [
  'requested',
  'reserved',
  'issued',
  'declined',
  'cancelled',
];
const BOOL = ['true', 'false'];
/** The store's routes: `stock.manage`, which a technician lacks. */
const store = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'manager',
  denied: 'technician',
  ...row,
});

/** The maintenance store (ADR 0065). */
export const STOCK_ROUTES: Row[] = [
  store({
    method: 'GET',
    path: '/maintenance/stores',
    foreign: 'none',
    invalid: 'none',
  }),
  store({
    method: 'POST',
    path: '/maintenance/stores',
    foreign: 'none',
    invalid: {
      body: { code: '-x', nameAr: '', nameEn: '', commonAreaId: 'x' },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT' },
        {
          field: 'nameAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
        {
          field: 'nameEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
        { field: 'commonAreaId', code: 'INVALID_UUID' },
      ],
    },
  }),
  store({
    method: 'GET',
    path: '/maintenance/stores/{id}',
    foreign: { params: (w) => ({ id: w.bStoreId }), code: 'STORE_NOT_FOUND' },
    invalid: 'none',
  }),
  store({
    method: 'PATCH',
    path: '/maintenance/stores/{id}',
    foreign: {
      params: (w) => ({ id: w.bStoreId }),
      body: () => ({ active: false }),
      code: 'STORE_NOT_FOUND',
    },
    invalid: {
      body: { active: 'no' },
      fields: [{ field: 'active', code: 'INVALID_TYPE' }],
    },
  }),
  store({
    method: 'GET',
    path: '/maintenance/stock/items',
    foreign: 'none',
    invalid: {
      query: { active: 'yes', below: '1' },
      fields: [
        { field: 'active', code: 'INVALID_VALUE', params: { allowed: BOOL } },
        { field: 'below', code: 'INVALID_VALUE', params: { allowed: BOOL } },
      ],
    },
  }),
  store({
    method: 'POST',
    path: '/maintenance/stock/items',
    foreign: 'none',
    invalid: {
      body: {
        sku: '',
        nameAr: '',
        nameEn: 'x',
        unit: 'gallon',
        reorderLevel: '-1',
      },
      fields: [
        { field: 'sku', code: 'INVALID_FORMAT' },
        {
          field: 'nameAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
        { field: 'unit', code: 'INVALID_VALUE', params: { allowed: UNITS } },
        { field: 'reorderLevel', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  store({
    method: 'GET',
    path: '/maintenance/stock/items/{id}',
    foreign: {
      params: (w) => ({ id: w.bStockItemId }),
      code: 'STOCK_ITEM_NOT_FOUND',
    },
    invalid: 'none',
  }),
  store({
    method: 'PATCH',
    path: '/maintenance/stock/items/{id}',
    foreign: {
      params: (w) => ({ id: w.bStockItemId }),
      body: () => ({ active: false }),
      code: 'STOCK_ITEM_NOT_FOUND',
    },
    invalid: {
      body: { reorderLevel: 'x', active: 1 },
      fields: [
        { field: 'reorderLevel', code: 'INVALID_FORMAT' },
        { field: 'active', code: 'INVALID_TYPE' },
      ],
    },
  }),
  store({
    method: 'POST',
    path: '/maintenance/stock/items/{id}/receive',
    foreign: {
      params: (w) => ({ id: w.bStockItemId }),
      body: (w) => ({ storeId: w.bStoreId, quantity: '1', unitCost: '5' }),
      code: 'STOCK_ITEM_NOT_FOUND',
    },
    invalid: {
      body: { storeId: 'x', quantity: '0', unitCost: '-1', reference: '' },
      fields: [
        { field: 'storeId', code: 'INVALID_UUID' },
        { field: 'quantity', code: 'INVALID_FORMAT' },
        { field: 'unitCost', code: 'INVALID_FORMAT' },
        {
          field: 'reference',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 60 },
        },
      ],
    },
  }),
  store({
    method: 'POST',
    path: '/maintenance/stock/items/{id}/adjust',
    foreign: {
      params: (w) => ({ id: w.bStockItemId }),
      body: (w) => ({ storeId: w.bStoreId, delta: '1', reasonCode: 'found' }),
      code: 'STOCK_ITEM_NOT_FOUND',
    },
    invalid: {
      body: { storeId: 'x', delta: '0', reasonCode: ['found'] },
      fields: [
        { field: 'storeId', code: 'INVALID_UUID' },
        { field: 'delta', code: 'INVALID_FORMAT' },
        { field: 'reasonCode', code: 'INVALID_TYPE' },
      ],
    },
  }),
  store({
    method: 'POST',
    path: '/maintenance/stock/items/{id}/transfer',
    foreign: {
      params: (w) => ({ id: w.bStockItemId }),
      body: (w) => ({
        fromStoreId: w.bStoreId,
        toStoreId: w.bTicketId,
        quantity: '1',
      }),
      code: 'STOCK_ITEM_NOT_FOUND',
    },
    invalid: {
      body: { fromStoreId: 'x', toStoreId: 'y', quantity: '1.0001' },
      fields: [
        { field: 'fromStoreId', code: 'INVALID_UUID' },
        { field: 'toStoreId', code: 'INVALID_UUID' },
        { field: 'quantity', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  store({
    method: 'GET',
    path: '/maintenance/stock/movements',
    foreign: 'none',
    invalid: {
      query: { itemId: 'x', storeId: 'y', ticketId: 'z' },
      fields: [
        { field: 'itemId', code: 'INVALID_UUID' },
        { field: 'storeId', code: 'INVALID_UUID' },
        { field: 'ticketId', code: 'INVALID_UUID' },
      ],
    },
  }),
  store({
    method: 'GET',
    path: '/maintenance/part-requests',
    foreign: 'none',
    invalid: {
      query: { status: 'open' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: PART_STATUSES },
        },
      ],
    },
  }),
  store({
    method: 'POST',
    path: '/maintenance/part-requests/{id}/reserve',
    foreign: {
      params: (w) => ({ id: w.bPartRequestId }),
      body: (w) => ({ storeId: w.bStoreId }),
      code: 'PART_REQUEST_NOT_FOUND',
    },
    invalid: {
      body: { storeId: 'x' },
      fields: [{ field: 'storeId', code: 'INVALID_UUID' }],
    },
  }),
  store({
    method: 'POST',
    path: '/maintenance/part-requests/{id}/issue',
    foreign: {
      params: (w) => ({ id: w.bPartRequestId }),
      code: 'PART_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
  }),
  store({
    method: 'POST',
    path: '/maintenance/part-requests/{id}/decline',
    foreign: {
      params: (w) => ({ id: w.bPartRequestId }),
      body: () => ({ reasonCode: 'out_of_stock' }),
      code: 'PART_REQUEST_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  }),
  {
    method: 'GET',
    path: '/maintenance/tickets/{id}/parts',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: { params: (w) => ({ id: w.bTicketId }), code: 'TICKET_NOT_FOUND' },
    invalid: 'none',
  },
];

/** The technician's parts (ADR 0065): `tickets.work`. */
const work = (row: Omit<Row, 'auth' | 'as' | 'denied'>): Row => ({
  auth: 'tenant',
  as: 'technician',
  denied: 'manager',
  ...row,
});

export const TECHNICIAN_PART_ROUTES: Row[] = [
  work({
    method: 'GET',
    path: '/technician/stock/items',
    foreign: 'none',
    invalid: {
      query: { q: '' },
      fields: [
        { field: 'q', code: 'INVALID_LENGTH', params: { min: 1, max: 60 } },
      ],
    },
  }),
  work({
    method: 'GET',
    path: '/technician/tickets/{id}/parts',
    foreign: { params: (w) => ({ id: w.bTicketId }), code: 'TICKET_NOT_FOUND' },
    invalid: 'none',
  }),
  work({
    method: 'POST',
    path: '/technician/tickets/{id}/part-requests',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: (w) => ({ itemId: w.bStockItemId, quantity: '1' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { itemId: 'x', quantity: '0' },
      fields: [
        { field: 'itemId', code: 'INVALID_UUID' },
        { field: 'quantity', code: 'INVALID_FORMAT' },
      ],
    },
  }),
  work({
    method: 'POST',
    path: '/technician/part-requests/{id}/cancel',
    foreign: {
      params: (w) => ({ id: w.bPartRequestId }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'PART_REQUEST_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  }),
  work({
    method: 'POST',
    path: '/technician/tickets/{id}/part-returns',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: (w) => ({
        itemId: w.bStockItemId,
        storeId: w.bStoreId,
        quantity: '1',
      }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { itemId: 'x', storeId: 'y', quantity: '-1' },
      fields: [
        { field: 'itemId', code: 'INVALID_UUID' },
        { field: 'storeId', code: 'INVALID_UUID' },
        { field: 'quantity', code: 'INVALID_FORMAT' },
      ],
    },
  }),
];
