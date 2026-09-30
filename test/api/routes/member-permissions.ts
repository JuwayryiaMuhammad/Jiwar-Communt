import type { Row } from '../registry';

const PERMISSIONS = [
  'visitors_invite',
  'bookings',
  'tickets',
  'finance',
  'unit_security',
];
const withReason = (body: object) => () => ({
  ...body,
  reasonCode: 'misuse',
  reason: 'Stated',
});

export const MEMBER_PERMISSIONS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/household/members/{id}/permissions',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.b.familyMemberId }),
      code: 'HOUSEHOLD_MEMBER_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/household/members/{id}/permissions/grant',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.b.familyMemberId }),
      body: () => ({ permission: 'unit_security' }),
      code: 'HOUSEHOLD_MEMBER_NOT_FOUND',
    },
    invalid: {
      body: { permission: 'everything' },
      fields: [
        {
          field: 'permission',
          code: 'INVALID_VALUE',
          params: { allowed: PERMISSIONS },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/household/members/{id}/permissions/revoke',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.b.familyMemberId }),
      body: withReason({ permission: 'bookings' }),
      code: 'HOUSEHOLD_MEMBER_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 'misuse', reason: 'x' },
      fields: [{ field: 'permission', code: 'FIELD_REQUIRED' }],
    },
  },
  {
    method: 'POST',
    path: '/household/members/{id}/permissions/revoke-all',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.b.familyMemberId }),
      body: withReason({}),
      code: 'HOUSEHOLD_MEMBER_NOT_FOUND',
    },
    invalid: {
      body: { reason: 1 },
      fields: [{ field: 'reason', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/household/members/{id}/permissions/revoke-by-management',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.familyMemberId }),
      body: withReason({ permission: 'all' }),
      code: 'HOUSEHOLD_MEMBER_NOT_FOUND',
    },
    invalid: {
      body: { permission: 'some' },
      fields: [
        {
          field: 'permission',
          code: 'INVALID_VALUE',
          params: { allowed: [...PERMISSIONS, 'all'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/units/{unitId}/deferred-actions',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/deferred-actions/{id}/decide',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bDeferredActionId }),
      body: () => ({ decision: 'approve' }),
      code: 'DEFERRED_ACTION_NOT_FOUND',
    },
    invalid: {
      body: { decision: 'maybe' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['approve', 'decline'] },
        },
      ],
    },
  },
];
