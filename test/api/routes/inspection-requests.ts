import type { Row } from '../registry';

/** Another compound's request, or none: the one not-found. */
const UNKNOWN = '0192a5f0-1c2b-7d3e-8f40-0000000063c1';

/** A closed unit's inspection requests and reports (ADR 0063). */
export const INSPECTION_REQUEST_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/units/{unitId}/inspection-requests',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({ preferredOn: '2099-01-05' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { preferredOn: 'soon' },
      fields: [
        {
          field: 'preferredOn',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/units/{unitId}/inspection-requests',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/inspection-requests/{id}/cancel',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, id: UNKNOWN }),
      body: () => ({ reasonCode: 'not_needed' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/units/{unitId}/inspections',
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
    method: 'GET',
    path: '/staff/security/inspection-requests',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'gone' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'scheduled', 'done', 'cancelled'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/security/inspection-requests/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({ reasonCode: 'other' }),
      code: 'INSPECTION_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
  },
];
