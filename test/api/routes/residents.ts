import { uniqueEmail } from '../../setup/http-app';
import type { Row } from '../registry';

export const RESIDENTS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/residents',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { limit: '-1' },
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
    method: 'POST',
    path: '/residents',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { fullName: 'x', units: [{ unitId: 'x', occupancyType: 'guest' }] },
      fields: [
        {
          field: 'fullName',
          code: 'INVALID_LENGTH',
          params: { min: 2, max: 200 },
        },
        { field: 'phone', code: 'FIELD_REQUIRED' },
        { field: 'email', code: 'FIELD_REQUIRED' },
        { field: 'units.0.unitId', code: 'INVALID_UUID' },
        {
          field: 'units.0.occupancyType',
          code: 'INVALID_VALUE',
          params: { allowed: ['owner', 'tenant'] },
        },
        { field: 'idDocumentType', code: 'FIELD_REQUIRED' },
        { field: 'idDocumentNumber', code: 'FIELD_REQUIRED' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/residents/{id}',
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
    method: 'PATCH',
    path: '/residents/{id}/contact',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.ids.owner }),
      body: () => ({ email: uniqueEmail('contact') }),
      code: 'ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: { email: 'nope' },
      fields: [{ field: 'email', code: 'INVALID_EMAIL' }],
    },
  },
  {
    method: 'POST',
    path: '/residents/{id}/occupancies',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.ids.owner }),
      body: (w) => ({ unitId: w.a.homeUnitId, occupancyType: 'tenant' }),
      code: 'ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: { unitId: 'x', occupancyType: 'guest' },
      fields: [
        { field: 'unitId', code: 'INVALID_UUID' },
        {
          field: 'occupancyType',
          code: 'INVALID_VALUE',
          params: { allowed: ['owner', 'tenant'] },
        },
      ],
    },
  },
];
