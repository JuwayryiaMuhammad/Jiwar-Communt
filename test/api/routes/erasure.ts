import type { Row } from '../registry';

export const ERASURE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/erasures',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { limit: '0' },
      fields: [
        {
          field: 'limit',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 100 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/erasures/{id}/scope',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bDeletionRequestId }),
      code: 'DELETION_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/erasures/{id}/erase',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bDeletionRequestId }),
      body: () => ({ typedScope: 'erase something' }),
      code: 'DELETION_REQUEST_NOT_FOUND',
    },
    invalid: {
      body: { typedScope: '' },
      fields: [
        {
          field: 'typedScope',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
      ],
    },
  },
  // ADR 0036: a queued request closed without erasing.
  {
    method: 'POST',
    path: '/erasures/{id}/close',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bDeletionRequestId }),
      body: () => ({ reasonCode: 'withdrawn' }),
      code: 'DELETION_REQUEST_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/accounts/{id}/legal-holds',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.ids.owner }),
      code: 'ACCOUNT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/accounts/{id}/legal-holds',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.ids.owner }),
      body: () => ({ reasonCode: 'litigation', reason: 'Court case' }),
      code: 'ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: [] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/legal-holds/{id}/release',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bLegalHoldId }),
      body: () => ({ reasonCode: 'resolved', reason: 'Settled' }),
      code: 'LEGAL_HOLD_NOT_FOUND',
    },
    invalid: {
      body: { reason: false },
      fields: [{ field: 'reason', code: 'INVALID_TYPE' }],
    },
  },
];
