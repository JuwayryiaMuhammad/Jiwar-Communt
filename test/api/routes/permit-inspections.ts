import type { Row } from '../registry';

/** Another compound's permit or inspection, or none: the one not-found. */
const UNKNOWN = '0192a5f0-1c2b-7d3e-8f40-0000000063d1';

/** Works completion inspections and their certificate (ADR 0063). */
export const PERMIT_INSPECTION_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/permits/{id}/completion-inspection',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'PERMIT_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/permits/{id}/completion-inspections',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'PERMIT_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/permits/{id}/completion-certificate',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'PERMIT_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/permit-inspections',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'gone' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['asked', 'passed', 'failed'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/permit-inspections/{id}/decide',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({ outcome: 'passed', photoFileIds: [UNKNOWN] }),
      code: 'PERMIT_INSPECTION_NOT_FOUND',
    },
    invalid: {
      body: { outcome: 'maybe', photoFileIds: [] },
      fields: [
        {
          field: 'outcome',
          code: 'INVALID_VALUE',
          params: { allowed: ['passed', 'failed'] },
        },
        { field: 'photoFileIds', code: 'INVALID_LENGTH', params: { min: 1 } },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/permit-inspections/{id}/certificate',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      code: 'PERMIT_INSPECTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/public/works-certificates/lookup',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    invalid: {
      body: {},
      fields: [{ field: 'code', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
];
