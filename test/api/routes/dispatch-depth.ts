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
  {
    method: 'PATCH',
    path: '/maintenance/sla-settings/escalation',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { normal: 10 },
      fields: [
        {
          field: 'normal',
          code: 'INVALID_NUMBER',
          params: { min: 50, max: 95 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/sla-report',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: '2026-04-31', to: '2026-05-01' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/sla-report/export',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: '2026-05-01', to: '2027-02-29' },
      fields: [{ field: 'to', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/maintenance/warranty-claims',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { assetId: 'x', status: 'lost' },
      fields: [
        { field: 'assetId', code: 'INVALID_UUID' },
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'accepted', 'rejected', 'withdrawn'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/warranty-claims',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({}),
      body: (w) => ({ assetId: w.bAssetId, description: 'Seal failed' }),
      code: 'ASSET_NOT_FOUND',
    },
    invalid: {
      body: { assetId: 'x', description: '' },
      fields: [
        { field: 'assetId', code: 'INVALID_UUID' },
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/warranty-claims/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bWarrantyClaimId }),
      code: 'WARRANTY_CLAIM_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/warranty-claims/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bWarrantyClaimId }),
      body: () => ({ reference: 'WR-1' }),
      code: 'WARRANTY_CLAIM_NOT_FOUND',
    },
    invalid: {
      body: { reference: '' },
      fields: [
        {
          field: 'reference',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/warranty-claims/{id}/accept',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bWarrantyClaimId }),
      body: () => ({ recoveredAmount: '10' }),
      code: 'WARRANTY_CLAIM_NOT_FOUND',
    },
    invalid: {
      body: { recoveredAmount: '1.234' },
      fields: [{ field: 'recoveredAmount', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/warranty-claims/{id}/reject',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bWarrantyClaimId }),
      body: () => ({ reasonCode: 'misuse' }),
      code: 'WARRANTY_CLAIM_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/warranty-claims/{id}/withdraw',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bWarrantyClaimId }),
      body: () => ({ reasonCode: 'raised_in_error' }),
      code: 'WARRANTY_CLAIM_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];
