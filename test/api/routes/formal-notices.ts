import type { Row } from '../registry';

const LIMIT_INVALID: Row['invalid'] = {
  query: { limit: '0' },
  fields: [
    { field: 'limit', code: 'INVALID_NUMBER', params: { min: 1, max: 100 } },
  ],
};

/** Formal notices and the late-payment notice (ADR 0058). */
export const FORMAL_NOTICE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/me/notices',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: LIMIT_INVALID,
  },
  {
    method: 'GET',
    path: '/me/notices/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    // Nobody's notice in B: an unknown id answers as another's would.
    foreign: {
      params: () => ({ id: '0192a5f0-1c2b-7d3e-8f40-0000000058e1' }),
      code: 'FORMAL_NOTICE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/finance/notice-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/staff/finance/notice-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { lateNoticeCureDays: 61 },
      fields: [
        {
          field: 'lateNoticeCureDays',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 60 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/finance/late-notices',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: LIMIT_INVALID,
  },
];
