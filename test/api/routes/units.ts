import type { Row } from '../registry';

const LIMIT = { min: 1, max: 100 };
const REASON = { reasonCode: 'moved_out', reason: 'Moved out' };

export const UNITS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units',
    auth: 'tenant',
    as: 'owner',
    // Every tenant role reads units; staff has no role yet.
    denied: 'none',
    foreign: 'none',
    invalid: {
      query: { limit: '101' },
      fields: [{ field: 'limit', code: 'INVALID_NUMBER', params: LIMIT }],
    },
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
    path: '/units/needing-review',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { limit: 'many' },
      fields: [{ field: 'limit', code: 'INVALID_NUMBER', params: LIMIT }],
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
  {
    method: 'POST',
    path: '/units/{id}/primary',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.homeUnitId }),
      body: (w) => ({ accountId: w.b.ids.owner }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { accountId: 'x' },
      fields: [{ field: 'accountId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'POST',
    path: '/units/{id}/closed-mode',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.b.homeUnitId }),
      body: () => ({ closed: true }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { closed: 'yes' },
      fields: [{ field: 'closed', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/units/{id}/activation',
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
    path: '/units/{id}/details',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.b.homeUnitId }),
      body: () => ({ step: 'building', value: 'B1' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { step: 'colour', value: '' },
      fields: [
        {
          field: 'step',
          code: 'INVALID_VALUE',
          params: { allowed: ['unitType', 'areaSqm', 'building'] },
        },
        { field: 'value', code: 'INVALID_LENGTH', params: { min: 1, max: 64 } },
      ],
    },
  },
  {
    method: 'POST',
    path: '/occupancies/{id}/end',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.occupancies.tenant }),
      body: () => REASON,
      code: 'OCCUPANCY_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5, reason: ['x'] },
      fields: [
        { field: 'reasonCode', code: 'INVALID_TYPE' },
        { field: 'reason', code: 'INVALID_TYPE' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/occupancies/{id}/convert-to-owner',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.occupancies.tenant }),
      body: () => ({}),
      code: 'OCCUPANCY_NOT_FOUND',
    },
    invalid: {
      body: { resides: 'no' },
      fields: [{ field: 'resides', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/occupancies/{id}/residence',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.occupancies.landlord }),
      body: () => ({ resides: true }),
      code: 'OCCUPANCY_NOT_FOUND',
    },
    invalid: {
      body: {},
      fields: [{ field: 'resides', code: 'FIELD_REQUIRED' }],
    },
  },
  {
    method: 'POST',
    path: '/occupancies/{id}/handover',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.occupancies.tenant }),
      code: 'OCCUPANCY_NOT_FOUND',
    },
    invalid: 'none',
  },
];
