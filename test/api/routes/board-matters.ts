import type { Row } from '../registry';

const pageInvalid = {
  query: { limit: '0' },
  fields: [
    { field: 'limit', code: 'INVALID_NUMBER', params: { min: 1, max: 100 } },
  ],
};

const APPROVAL_TYPES = [
  'annual_budget',
  'budget_increase',
  'major_contract',
  'exceptional_fee',
  'waiver_above_limit',
  'payment_plan_above_limit',
  'legal_escalation',
];

/** Approval requests, the staff's side (ADR 0055). */
export const STAFF_APPROVAL_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/staff/governance/approvals',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { type: 'king', context: 'c', impact: 'i' },
      fields: [
        {
          field: 'type',
          code: 'INVALID_VALUE',
          params: { allowed: APPROVAL_TYPES },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/approvals',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/approvals/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      code: 'APPROVAL_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/governance/approvals/{id}/withdraw',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'APPROVAL_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/governance/approvals/{id}/implemented',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      body: () => ({}),
      code: 'APPROVAL_NOT_FOUND',
    },
    invalid: {
      body: { note: '' },
      fields: [
        {
          field: 'note',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/governance/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { items: [{ type: 'king' }] },
      fields: [
        {
          field: 'items.0.type',
          code: 'INVALID_VALUE',
          params: { allowed: [...APPROVAL_TYPES, 'board_appeal'] },
        },
      ],
    },
    noStore: true,
  },
];

/** The board's requests and motions (ADR 0055): A's landlord sits on A's board. */
export const BOARD_APPROVAL_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/board/approvals',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/approvals/{id}',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      code: 'APPROVAL_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/approvals/{id}/motions',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bApprovalId }),
      body: () => ({ outcome: 'approve', rationale: 'Sound.' }),
      code: 'APPROVAL_NOT_FOUND',
    },
    invalid: {
      body: { outcome: 'maybe', rationale: 'Sound.' },
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
    path: '/board/motions/{id}/votes',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardMotionId }),
      body: () => ({ choice: 'for' }),
      code: 'BOARD_MOTION_NOT_FOUND',
    },
    invalid: {
      body: { choice: 'maybe' },
      fields: [
        {
          field: 'choice',
          code: 'INVALID_VALUE',
          params: { allowed: ['for', 'against'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/motions/{id}/close',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardMotionId }),
      code: 'BOARD_MOTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/motions/{id}/withdraw',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardMotionId }),
      code: 'BOARD_MOTION_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];
