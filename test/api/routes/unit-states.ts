import type { Row } from '../registry';

const reason = (reasonCode: string) => () => ({ reasonCode, reason: 'Stated' });

export const UNIT_STATES_ROUTES: Row[] = [
  ...(['deceased', 'separation'] as const).map((verb): Row => ({
    method: 'POST',
    path: `/units/{id}/${verb}`,
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.homeUnitId }),
      body: reason(verb),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 1 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  })),
  {
    method: 'POST',
    path: '/review-flags/{id}/clear',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFlagId }),
      body: () => ({ reasonCode: 'resolved' }),
      code: 'REVIEW_FLAG_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: true, reason: 'not accepted here' },
      fields: [
        { field: 'reason', code: 'FIELD_NOT_ALLOWED' },
        { field: 'reasonCode', code: 'INVALID_TYPE' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/units/{id}/end-household',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.homeUnitId }),
      body: reason('household_left'),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { reason: 42 },
      fields: [{ field: 'reason', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/units/{id}/transfer-ownership',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.homeUnitId }),
      body: (w) => ({
        toAccountId: w.b.ids.tenant,
        reasonCode: 'unit_changed_hands',
        reason: 'Sold',
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { toAccountId: 'x', resides: 'no' },
      fields: [
        { field: 'toAccountId', code: 'INVALID_UUID' },
        { field: 'resides', code: 'INVALID_TYPE' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/units/{id}/household/to-review',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{id}/household/reviewed',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.b.homeUnitId }),
      body: () => ({ all: true }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { memberIds: ['x'], all: true },
      fields: [
        { field: 'memberIds', code: 'INVALID_UUID' },
        { field: 'all', code: 'INVALID_VALUE' },
      ],
    },
  },
];
