import type { Row } from '../registry';

export const ACCOUNTS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/accounts/me',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/accounts',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/accounts',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { type: 'guest', fullName: 'X', phone: '123' },
      fields: [
        {
          field: 'type',
          code: 'INVALID_VALUE',
          params: { allowed: ['resident', 'staff', 'manager', 'family'] },
        },
        {
          field: 'fullName',
          code: 'INVALID_LENGTH',
          params: { min: 2, max: 200 },
        },
        {
          field: 'idDocumentType',
          code: 'FIELD_REQUIRED',
        },
        { field: 'idDocumentNumber', code: 'FIELD_REQUIRED' },
        { field: 'phone', code: 'INVALID_PHONE' },
        { field: 'email', code: 'FIELD_REQUIRED' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/accounts/{id}',
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
    path: '/accounts/{id}/status',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.ids.owner }),
      body: () => ({ status: 'inactive' }),
      code: 'ACCOUNT_NOT_FOUND',
    },
    invalid: {
      body: { status: 'gone' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['active', 'inactive', 'frozen', 'erased'] },
        },
      ],
    },
  },
];
