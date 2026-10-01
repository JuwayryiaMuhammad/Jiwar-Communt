import type { Row } from '../registry';

/** Approvals at the gate: the guard asks, the household answers (ADR 0028). */
export const APPROVALS_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/approval-requests',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        kind: 'worker_off_schedule',
        engagementId: w.bEngagementId,
      }),
      code: 'ENGAGEMENT_NOT_FOUND',
    },
    invalid: {
      body: { kind: 'pizza', partySize: 0 },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['uninvited_visitor', 'delivery', 'worker_off_schedule'],
          },
        },
        {
          field: 'partySize',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 50 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/gate/approval-requests/{id}',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bRequestId }),
      code: 'GATE_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/gate/approval-requests/{id}/withdraw',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bRequestId }),
      code: 'GATE_REQUEST_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/me/gate-requests',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/gate-requests/{id}/decide',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bRequestId }),
      body: () => ({ decision: 'approve' }),
      code: 'GATE_REQUEST_NOT_FOUND',
    },
    invalid: {
      body: { decision: 'maybe' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['approve', 'deny'] },
        },
      ],
    },
  },
];
