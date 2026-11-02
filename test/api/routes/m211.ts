import type { Row } from '../registry';

/** None of these in compound B, or nowhere: the one not-found. */
const UNKNOWN = '0192a5f0-1c2b-7d3e-8f40-0000000083b1';

/**
 * Transfers, dues and closed units, and the market's completion (ADR
 * 0083): ownership transfer requests and their dues gate, the
 * management's end of a proxy, the closed units and their rounds, the
 * emergency entries, and a group offer's contract and re-confirmation.
 */
export const M211_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/staff/units/{unitId}/ownership-transfers',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({
        toAccountId: UNKNOWN,
        reasonCode: 'unit_changed_hands',
        reason: 'Sold',
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { toAccountId: 'x' },
      fields: [{ field: 'toAccountId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/ownership-transfers',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { unitId: 'x' },
      fields: [{ field: 'unitId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/ownership-transfers/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      code: 'OWNERSHIP_TRANSFER_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/ownership-transfers/{id}/approve',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({}),
      code: 'OWNERSHIP_TRANSFER_NOT_FOUND',
    },
    invalid: {
      body: { duesExceptionCode: 5 },
      fields: [{ field: 'duesExceptionCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/staff/ownership-transfers/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({ reasonCode: 'other' }),
      code: 'OWNERSHIP_TRANSFER_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/staff/units/{unitId}/proxies/{id}/revoke',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, id: UNKNOWN }),
      body: () => ({ reasonCode: 'misuse' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/security/closed-units',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/security/unit-entries',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        unitId: w.b.homeUnitId,
        reasonCode: 'water_leak',
        enteredAt: new Date().toISOString(),
        witnessIds: [UNKNOWN],
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: {
        unitId: 'x',
        enteredAt: '2099-02-30T08:00:00Z',
        witnessIds: [UNKNOWN],
      },
      fields: [
        { field: 'unitId', code: 'INVALID_UUID' },
        { field: 'enteredAt', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/unit-entries',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { unitId: 'x' },
      fields: [{ field: 'unitId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/unit-entries/{id}',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      code: 'UNIT_ENTRY_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/unit-entries/{id}/report',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({
        outcome: 'resolved',
        note: 'Closed the valve.',
        photoFileIds: [UNKNOWN],
      }),
      code: 'UNIT_ENTRY_NOT_FOUND',
    },
    invalid: {
      body: { outcome: 'resolved', note: 5, photoFileIds: [UNKNOWN] },
      fields: [{ field: 'note', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/units/{unitId}/entries',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/group-offers/{id}/contract',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bGroupOfferId }),
      body: () => ({ finalPrice: '900' }),
      code: 'GROUP_OFFER_NOT_FOUND',
    },
    invalid: {
      body: { finalPrice: 'cheap' },
      fields: [{ field: 'finalPrice', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/market/group-offers/{id}/reconfirm',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bGroupOfferId }),
      code: 'GROUP_OFFER_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];
