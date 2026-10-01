import type { Row } from '../registry';

/** The gate log: verify, entries, who is inside (ADR 0028). */
export const ENTRIES_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/verify',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    // Another compound's code is just unknown (an enumeration test).
    foreign: 'none',
    invalid: {
      body: { code: '' },
      fields: [
        { field: 'code', code: 'INVALID_LENGTH', params: { min: 1, max: 32 } },
      ],
    },
  },
  {
    method: 'POST',
    path: '/gate/entries',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        subjectType: 'visitor_pass',
        subjectId: w.bPassId,
        direction: 'in',
      }),
      code: 'GATE_SUBJECT_NOT_FOUND',
    },
    invalid: {
      body: { subjectType: 'car', subjectId: 'x', direction: 'up' },
      fields: [
        {
          field: 'subjectType',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['visitor_pass', 'worker_engagement', 'gate_request'],
          },
        },
        { field: 'subjectId', code: 'INVALID_UUID' },
        {
          field: 'direction',
          code: 'INVALID_VALUE',
          params: { allowed: ['in', 'out'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/gate/entries',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { direction: 'up' },
      fields: [
        {
          field: 'direction',
          code: 'INVALID_VALUE',
          params: { allowed: ['in', 'out'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/gate/inside',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: 'none',
  },
];
