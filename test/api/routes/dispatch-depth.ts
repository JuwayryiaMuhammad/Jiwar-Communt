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
];
