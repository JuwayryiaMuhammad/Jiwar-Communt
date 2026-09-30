import type { Row } from '../registry';

/** Endpoints that existed before API v0 (auth, health, accounts, units). */
export const EXISTING_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/health',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/auth/otp/request',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: {},
      fields: [{ field: 'identifier', code: 'FIELD_REQUIRED' }],
    },
  },
  {
    method: 'POST',
    path: '/auth/otp/verify',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { identifier: 'someone@example.test', code: '12' },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT', params: { length: 6 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/auth/select-account',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { loginTicket: 'x'.repeat(40), accountId: 'nope' },
      fields: [{ field: 'accountId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/auth/refresh',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { refreshToken: 'short' },
      fields: [
        {
          field: 'refreshToken',
          code: 'INVALID_LENGTH',
          params: { min: 20, max: 200 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/auth/logout',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: {},
      fields: [{ field: 'refreshToken', code: 'FIELD_REQUIRED' }],
    },
  },
];
