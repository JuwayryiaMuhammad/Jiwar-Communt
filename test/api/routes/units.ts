import type { Row } from '../registry';

export const UNITS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units',
    auth: 'tenant',
    as: 'owner',
    // Every tenant role reads units; staff has no role yet.
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { code: '', floor: 500 },
      fields: [
        { field: 'code', code: 'INVALID_LENGTH', params: { min: 1, max: 32 } },
        {
          field: 'floor',
          code: 'INVALID_NUMBER',
          params: { min: -5, max: 200 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/units/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
];
