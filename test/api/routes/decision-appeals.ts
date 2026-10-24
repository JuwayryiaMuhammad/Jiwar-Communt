import type { Row } from '../registry';

const pageInvalid = {
  query: { limit: '0' },
  fields: [
    { field: 'limit', code: 'INVALID_NUMBER', params: { min: 1, max: 100 } },
  ],
};

const KINDS = [
  'permit_rejection',
  'vehicle_rejection',
  'worker_rejection',
  'neighbour_notice',
];

const foreign: Row['foreign'] = {
  params: (w) => ({ id: w.bDecisionAppealId }),
  code: 'DECISION_APPEAL_NOT_FOUND',
};

/** Decision appeals to the management (ADR 0059). */
export const DECISION_APPEAL_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/decision-appeals',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        kind: 'king',
        subjectId: '0193b8a4-0000-7000-8000-000000000000',
        grounds: 'g',
      },
      fields: [
        { field: 'kind', code: 'INVALID_VALUE', params: { allowed: KINDS } },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/decision-appeals',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/decision-appeals/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign,
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/decision-appeals/{id}/withdraw',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign,
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/decision-appeals',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'king' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['pending', 'upheld', 'overturned', 'withdrawn'],
          },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/decision-appeals/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign,
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/decision-appeals/{id}/decide',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      ...foreign,
      body: () => ({ outcome: 'upheld', rationale: 'Reviewed.' }),
    },
    invalid: {
      body: { outcome: 'maybe', rationale: 'Reviewed.' },
      fields: [
        {
          field: 'outcome',
          code: 'INVALID_VALUE',
          params: { allowed: ['upheld', 'overturned'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/decision-appeals/{id}/followed-up',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign,
    invalid: 'none',
    noStore: true,
  },
];
