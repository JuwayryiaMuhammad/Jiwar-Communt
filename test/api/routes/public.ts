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
  // The visitor's page (ADR 0030): the token is the only input, and every
  // response is no-store (the code or the secret travels in it).
  ...(['lookup', 'not-me'] as const).map((verb): Row => ({
    method: 'POST',
    path: `/public/visitor-passes/${verb}`,
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: { token: 5, unitId: 'x' },
      fields: [
        { field: 'unitId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'token', code: 'INVALID_TYPE' },
      ],
    },
  })),
];
