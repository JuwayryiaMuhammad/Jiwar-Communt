import type { Row } from '../registry';

const pageInvalid = {
  query: { limit: '0' },
  fields: [
    { field: 'limit', code: 'INVALID_NUMBER', params: { min: 1, max: 100 } },
  ],
};

const bodyInvalid = {
  body: { body: '' },
  fields: [
    {
      field: 'body',
      code: 'INVALID_LENGTH',
      params: { min: 1, max: 2000 },
    },
  ],
};

const matterForeign: Row['foreign'] = {
  params: (w) => ({ id: w.bRepresentativeMatterId }),
  code: 'REPRESENTATIVE_MATTER_NOT_FOUND',
};

/** Building representatives, the board's matters on them, and their threads (ADR 0059). */
export const REPRESENTATIVE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/board/representatives',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/representatives/buildings',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/representatives/candidates',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { building: '' },
      fields: [
        {
          field: 'building',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 100 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/representatives/matters',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { action: 'king' },
      fields: [
        {
          field: 'action',
          code: 'INVALID_VALUE',
          params: { allowed: ['appoint', 'end'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/representatives/matters',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'king' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['pending', 'approved', 'rejected', 'withdrawn'],
          },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/representatives/matters/{id}',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: matterForeign,
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/representatives/matters/{id}/motions',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      ...matterForeign,
      body: () => ({ outcome: 'approve', rationale: 'Willing.' }),
    },
    invalid: {
      body: { outcome: 'maybe', rationale: 'Willing.' },
      fields: [
        {
          field: 'outcome',
          code: 'INVALID_VALUE',
          params: { allowed: ['approve', 'reject'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/representatives/matters/{id}/withdraw',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: matterForeign,
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/representatives',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/representatives',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/representatives/{id}/messages',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRepresentativeId }),
      code: 'REPRESENTATIVE_NOT_FOUND',
    },
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'POST',
    path: '/me/representatives/{id}/messages',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRepresentativeId }),
      code: 'REPRESENTATIVE_NOT_FOUND',
      body: () => ({ body: 'Hello' }),
    },
    invalid: bodyInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/representation/threads',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/representation/threads/{id}/messages',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRepresentativeThreadId }),
      code: 'REPRESENTATIVE_THREAD_NOT_FOUND',
    },
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'POST',
    path: '/me/representation/threads/{id}/messages',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRepresentativeThreadId }),
      code: 'REPRESENTATIVE_THREAD_NOT_FOUND',
      body: () => ({ body: 'Hello' }),
    },
    invalid: bodyInvalid,
    noStore: true,
  },
];
