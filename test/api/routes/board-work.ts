import type { Row } from '../registry';

const pageInvalid = {
  query: { limit: '0' },
  fields: [
    { field: 'limit', code: 'INVALID_NUMBER', params: { min: 1, max: 100 } },
  ],
};
const meeting = (body?: object): Row['foreign'] => ({
  params: (w) => ({ id: w.bMeetingId }),
  code: 'BOARD_MEETING_NOT_FOUND',
  ...(body ? { body: () => body } : {}),
});
const action = (body?: object): Row['foreign'] => ({
  params: (w) => ({ id: w.bMeetingActionId }),
  code: 'BOARD_MEETING_ACTION_NOT_FOUND',
  ...(body ? { body: () => body } : {}),
});
const UUID = '0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e5f';

/**
 * The board's work (ADR 0075): units' ownership shares for weighted polls,
 * board meetings and their action items, the handover packs, and the
 * monthly board report.
 */
export const BOARD_WORK_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/governance/unit-shares',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/governance/unit-shares',
    auth: 'tenant',
    as: 'manager',
    denied: 'landlord',
    foreign: 'none',
    invalid: {
      body: { shares: [] },
      fields: [
        {
          field: 'shares',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 500 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/governance/rules',
    auth: 'tenant',
    as: 'manager',
    denied: 'landlord',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/governance/rules',
    auth: 'tenant',
    as: 'manager',
    denied: 'landlord',
    foreign: 'none',
    invalid: {
      body: { candidacyNoDues: 'yes' },
      fields: [{ field: 'candidacyNoDues', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/meetings',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'king' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['scheduled', 'held', 'cancelled'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/meetings',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: {
        kind: 'regular',
        title: '',
        scheduledAt: '2099-02-30T08:00:00Z',
      },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
        { field: 'scheduledAt', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/meetings/{id}',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: meeting(),
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/board/meetings/{id}',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: meeting({ title: 'A new title' }),
    invalid: {
      body: { title: '' },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/meetings/{id}/hold',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: meeting({ presentMemberIds: [] }),
    invalid: {
      body: { presentMemberIds: ['x'] },
      fields: [{ field: 'presentMemberIds', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/meetings/{id}/cancel',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: meeting({ reasonCode: 'postponed' }),
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/meetings/{id}/minutes',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: meeting({ publicationId: UUID }),
    invalid: {
      body: { publicationId: 'x' },
      fields: [{ field: 'publicationId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/meetings/{id}/actions',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: meeting({
      title: 'An item',
      ownerAccountId: UUID,
      dueOn: '2099-01-01',
    }),
    invalid: {
      body: { title: '', ownerAccountId: UUID, dueOn: '2026-02-30' },
      fields: [
        {
          field: 'title',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 300 },
        },
        { field: 'dueOn', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/board/meeting-actions',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: 'none',
    invalid: pageInvalid,
    noStore: true,
  },
  {
    method: 'POST',
    path: '/board/meeting-actions/{id}/done',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: action(),
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
    method: 'POST',
    path: '/board/meeting-actions/{id}/cancel',
    auth: 'tenant',
    as: 'landlord',
    denied: 'owner',
    foreign: action({ reasonCode: 'not_needed' }),
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
];
