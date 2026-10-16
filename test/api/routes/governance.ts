import type { Row } from '../registry';

const pageInvalid = {
  query: { limit: '0' },
  fields: [
    { field: 'limit', code: 'INVALID_NUMBER', params: { min: 1, max: 100 } },
  ],
};

/** The owners' board, the owners' side (ADR 0051). */
export const GOVERNANCE_BOARD_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/governance/board',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/governance/board/terms',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
];

/** The board register, the manager's side (ADR 0051). */
export const STAFF_BOARD_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/governance/board',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/board/terms',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/governance/board/appoint',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: {
        seats: 99,
        endsAt: '2099-01-01T00:00:00.000Z',
        members: [{ accountId: 'x', role: 'king' }],
      },
      fields: [
        { field: 'seats', code: 'INVALID_NUMBER', params: { min: 3, max: 15 } },
        { field: 'members.0.accountId', code: 'INVALID_UUID' },
        { field: 'members.0.role', code: 'INVALID_VALUE' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/governance/board/members',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { accountId: 'x', role: 'member' },
      fields: [{ field: 'accountId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/governance/board/members/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardMemberId }),
      code: 'BOARD_MEMBER_NOT_FOUND',
      body: () => ({ role: 'member' }),
    },
    invalid: {
      body: { role: 'king' },
      fields: [{ field: 'role', code: 'INVALID_VALUE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/governance/board/members/{id}/end',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBoardMemberId }),
      code: 'BOARD_MEMBER_NOT_FOUND',
      body: () => ({ reasonCode: 'resigned' }),
    },
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/owners',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { search: '' },
      fields: [
        {
          field: 'search',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
      ],
    },
    noStore: true,
  },
];
