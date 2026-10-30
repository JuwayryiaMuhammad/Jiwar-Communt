import type { Row } from '../registry';

/** A valid one-time pass for one visitor, starting now. */
export const passBody = (over: object = {}) => ({
  kind: 'one_time',
  partySize: 1,
  validFrom: new Date().toISOString(),
  validUntil: new Date(Date.now() + 4 * 3_600_000).toISOString(),
  ...over,
});

/** Visitor passes and a household's gate instructions (ADR 0028). */
export const VISITORS_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/units/{unitId}/visitor-passes',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    noStore: true,
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => passBody(),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: {
        kind: 'daily',
        partySize: 0,
        validFrom: '2099-02-30T08:00:00Z',
        validUntil: '2099-04-31T10:00:00+03:00',
      },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['one_time', 'recurring'] },
        },
        {
          field: 'partySize',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 50 },
        },
        { field: 'validFrom', code: 'INVALID_FORMAT' },
        { field: 'validUntil', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/units/{unitId}/visitor-passes',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/visitor-passes/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    noStore: true,
    foreign: {
      params: (w) => ({ id: w.bPassId }),
      code: 'VISITOR_PASS_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/visitor-passes/{id}/reissue-link',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    noStore: true,
    foreign: {
      params: (w) => ({ id: w.bPassId }),
      code: 'VISITOR_PASS_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/visitor-passes/{id}/cancel',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPassId }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'VISITOR_PASS_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/units/{unitId}/gate-instructions',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'PUT',
    path: '/units/{unitId}/gate-instructions',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({ uninvitedVisitor: 'deny', delivery: 'leave_at_gate' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { uninvitedVisitor: 'maybe', delivery: 'drone' },
      fields: [
        {
          field: 'uninvitedVisitor',
          code: 'INVALID_VALUE',
          params: { allowed: ['ask', 'allow', 'deny'] },
        },
        {
          field: 'delivery',
          code: 'INVALID_VALUE',
          params: { allowed: ['ask', 'allow', 'leave_at_gate', 'deny'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/units/{unitId}/standing-instructions',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/standing-instructions',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({ description: 'Someone', action: 'call_first' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { description: '', action: 'sometimes' },
      fields: [
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 140 },
        },
        {
          field: 'action',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'always_allow',
              'never_allow',
              'call_first',
              'leave_at_gate',
            ],
          },
        },
      ],
    },
  },
  {
    method: 'DELETE',
    path: '/units/{unitId}/standing-instructions/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({
        unitId: w.b.homeUnitId,
        id: '00000000-0000-7000-8000-000000000000',
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
];
