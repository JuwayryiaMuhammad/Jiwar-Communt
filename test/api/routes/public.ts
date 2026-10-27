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
  // A registrant's status link (ADR 0062): the token is the credential and
  // every response is no-store. A document of no request of the link's is
  // its own 404.
  ...(['status', 'resubmit'] as const).map((verb): Row => ({
    method: 'POST',
    path: `/public/registrations/${verb}`,
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: { token: 5, registrationId: 'x' },
      fields: [
        { field: 'registrationId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'token', code: 'INVALID_TYPE' },
      ],
    },
  })),
  {
    method: 'POST',
    path: '/public/registrations/uploads',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: {
        token: 'x',
        kind: 'deed',
        contentType: 'application/pdf',
        size: 0,
      },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['ownership_proof', 'lease_proof', 'other_proof'],
          },
        },
        { field: 'size', code: 'INVALID_NUMBER', params: { min: 1 } },
      ],
    },
  },
  ...(['finalize', 'remove'] as const).map((verb): Row => ({
    method: 'POST',
    path: `/public/registrations/documents/{id}/${verb}`,
    auth: 'public',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bRegistrationId }),
      body: (w) => ({ token: w.bRegistrationStatusToken }),
      code: 'REGISTRATION_DOCUMENT_NOT_FOUND',
    },
    noStore: true,
    invalid: {
      body: { token: 5 },
      fields: [{ field: 'token', code: 'INVALID_TYPE' }],
    },
  })),
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
