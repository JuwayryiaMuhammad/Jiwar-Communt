import type { Row } from '../registry';

/**
 * Dispatch depth (ADR 0076): the management's own work orders, dispatch's
 * own moves on a ticket, the ticket list's search and export, the SLA's
 * escalation levels and report, an asset's timeline and warranty claims,
 * and the calendar of planned work.
 */
export const DISPATCH_DEPTH_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/maintenance/work-orders',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        assetId: w.bAssetId,
        categoryId: w.aCategoryId,
        description: 'Leaks',
      }),
      code: 'ASSET_NOT_FOUND',
    },
    invalid: {
      body: { meterAlertId: 'x', categoryId: 'y', description: '' },
      fields: [
        { field: 'meterAlertId', code: 'INVALID_UUID' },
        { field: 'categoryId', code: 'INVALID_UUID' },
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/close',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ reasonCode: 'confirmed_by_phone' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/reopen',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ reasonCode: 'not_fixed', reason: 'Still leaking' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/tickets/{id}/resume',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: { params: (w) => ({ id: w.bTicketId }), code: 'TICKET_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/maintenance/tickets/export',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: '2026-02-30', to: '2026-03-01', q: '' },
      fields: [
        { field: 'from', code: 'INVALID_FORMAT' },
        {
          field: 'q',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 40 },
        },
      ],
    },
    noStore: true,
  },
];
