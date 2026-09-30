import type { Row } from '../registry';

export const PUBLIC_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/invites/accept/start',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: {},
      fields: [{ field: 'token', code: 'FIELD_REQUIRED' }],
    },
  },
  {
    method: 'POST',
    path: '/invites/accept/complete',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { token: 'x', code: '12ab' },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT', params: { length: 6 } },
      ],
    },
  },
  {
    method: 'POST',
    path: '/registrations/start',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { fullName: 5, resides: 'yes', tenantId: 'x' },
      fields: [
        { field: 'tenantId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'fullName', code: 'INVALID_TYPE' },
        { field: 'resides', code: 'INVALID_TYPE' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/registrations/complete',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { code: 'abc' },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT', params: { length: 6 } },
      ],
    },
  },
];
