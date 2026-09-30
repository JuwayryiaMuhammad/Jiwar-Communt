import type { Row } from '../registry';

const LIMIT = { min: 1, max: 100 };

export const REGISTRATION_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/registration-links',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { limit: '1000' },
      fields: [{ field: 'limit', code: 'INVALID_NUMBER', params: LIMIT }],
    },
  },
  {
    method: 'POST',
    path: '/registration-links',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    // No body.
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/registration-links/{id}/revoke',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bLinkId }),
      code: 'REGISTRATION_LINK_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/registrations',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { cursor: '' },
      fields: [
        {
          field: 'cursor',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 512 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/registrations/{id}/approve',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bRegistrationId }),
      body: () => ({}),
      code: 'REGISTRATION_NOT_FOUND',
    },
    invalid: {
      body: { unitId: 'x', linkToExistingAccount: 'yes' },
      fields: [
        { field: 'unitId', code: 'INVALID_UUID' },
        { field: 'linkToExistingAccount', code: 'INVALID_TYPE' },
      ],
    },
  },
  {
    method: 'POST',
    path: '/registrations/{id}/reject',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bRegistrationId }),
      body: () => ({ reasonCode: 'other', reason: 'No' }),
      code: 'REGISTRATION_NOT_FOUND',
    },
    invalid: {
      body: { reason: 1 },
      fields: [{ field: 'reason', code: 'INVALID_TYPE' }],
    },
  },
];
