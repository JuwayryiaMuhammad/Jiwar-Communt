import { bornYearsAgo, nationalIdFor } from '../../setup/fixtures';
import { uniqueEmail, uniquePhone } from '../../setup/http-app';
import type { Row } from '../registry';

export const inviteBody = () => ({
  fullName: 'Invited Adult',
  phone: uniquePhone(),
  email: uniqueEmail('invite'),
  idDocumentType: 'national_id',
  idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
  relation: 'sibling',
});

export const minorBody = () => ({
  fullName: 'Young One',
  idDocumentType: 'national_id',
  idDocumentNumber: nationalIdFor(bornYearsAgo(8)),
  relation: 'child',
});

const RELATIONS = {
  allowed: ['spouse', 'child', 'parent', 'sibling', 'other'],
};
const reason = (reasonCode: string) => () => ({ reasonCode, reason: 'Stated' });

export const HOUSEHOLD_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/household',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/household/invites',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: inviteBody,
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { ...inviteBody(), relation: 'friend' },
      fields: [{ field: 'relation', code: 'INVALID_VALUE', params: RELATIONS }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/household/invites/{id}/revoke',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: { params: (w) => ({ id: w.bInviteId }), code: 'INVITE_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/household/minors',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: minorBody,
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { ...minorBody(), fullName: 'K' },
      fields: [
        {
          field: 'fullName',
          code: 'INVALID_LENGTH',
          params: { min: 2, max: 200 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/units/{unitId}/household/minors-ready',
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
    path: '/household/members/{id}/majority-invite',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.b.familyMemberId }),
      body: () => ({ email: uniqueEmail('adult'), phone: uniquePhone() }),
      code: 'HOUSEHOLD_MEMBER_NOT_FOUND',
    },
    invalid: {
      body: { email: 'x', phone: '1' },
      fields: [
        { field: 'email', code: 'INVALID_EMAIL' },
        { field: 'phone', code: 'INVALID_PHONE' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/household/members/{id}/remove',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.b.familyMemberId }),
      body: reason('moved_out'),
      code: 'HOUSEHOLD_MEMBER_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: {} },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/household/pending',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { limit: '0' },
      fields: [
        {
          field: 'limit',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 100 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/household/members/{id}/approve',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.familyMemberId }),
      code: 'HOUSEHOLD_MEMBER_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/household/members/{id}/reject',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.familyMemberId }),
      body: reason('other'),
      code: 'HOUSEHOLD_MEMBER_NOT_FOUND',
    },
    invalid: {
      body: { reason: 7 },
      fields: [{ field: 'reason', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/household/members/{id}/remove-by-management',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.familyMemberId }),
      body: reason('separation'),
      code: 'HOUSEHOLD_MEMBER_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: false },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];
