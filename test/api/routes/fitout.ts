import type { Row } from '../registry';

/** Another compound's permit, or none: the one not-found. */
const UNKNOWN = '0192a5f0-1c2b-7d3e-8f40-0000000074d1';

/** A works permit's fit-out (ADR 0074). */
export const FITOUT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/permits/{id}/fit-out',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'PERMIT_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/drawings',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({ fileId: UNKNOWN }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: {
      body: { fileId: 'x' },
      fields: [{ field: 'fileId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/drawings/{drawingId}/remove',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: () => ({ id: UNKNOWN, drawingId: UNKNOWN }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/unit-permits/{id}/fit-out',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'PERMIT_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
];
