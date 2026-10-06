import type { Row } from '../registry';

const LINK_INVALID = [
  { field: 'accountId', code: 'FIELD_NOT_ALLOWED' },
  { field: 'token', code: 'INVALID_TYPE' },
];

/** Personal-data export (ADR 0036): the caller's own, and the email link. */
export const EXPORTS_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/me/data-exports',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/me/data-exports',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/me/data-exports/{id}/download',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bExportId }),
      code: 'DATA_EXPORT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/public/data-exports/code',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: { body: { token: 5, accountId: 'x' }, fields: LINK_INVALID },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/public/data-exports/download',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: { token: 'x', code: '12' },
      fields: [
        { field: 'code', code: 'INVALID_FORMAT', params: { length: 6 } },
      ],
    },
    noStore: true,
  },
];
