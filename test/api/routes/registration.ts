import type { Row } from '../registry';
import type { World } from '../world';

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
      query: { cursor: '', status: 'approved' },
      // The status is declared on the subclass: its error comes first.
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['pending', 'needs_correction'] },
        },
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
    method: 'GET',
    path: '/registrations/{id}/documents/{documentId}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bRegistrationId, documentId: w.bRegistrationId }),
      code: 'REGISTRATION_DOCUMENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/registrations/{id}/request-correction',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bRegistrationId }),
      body: () => ({ codes: ['document_missing'] }),
      code: 'REGISTRATION_NOT_FOUND',
    },
    invalid: {
      body: { codes: [] },
      fields: [{ field: 'codes', code: 'INVALID_LENGTH', params: { min: 1 } }],
    },
  },
  // Name and phone changes residents asked for (ADR 0062).
  {
    method: 'GET',
    path: '/identity-changes',
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
    path: '/identity-changes/{id}/approve',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bRegistrationId }),
      code: 'IDENTITY_CHANGE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/identity-changes/{id}/reject',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bRegistrationId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'IDENTITY_CHANGE_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
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

// A unit's document vault (ADR 0062).
const NEW_DOCUMENT_INVALID = {
  body: {
    fileId: 'x',
    kind: 'deed',
    title: '',
    visibility: 'all',
    // Shaped as a day, and no day.
    expiresOn: '2026-02-30',
  },
  fields: [
    { field: 'fileId', code: 'INVALID_UUID' },
    {
      field: 'kind',
      code: 'INVALID_VALUE',
      params: {
        allowed: [
          'warranty',
          'manual',
          'handover_report',
          'utility',
          'insurance',
          'inspection_report',
          'other',
        ],
      },
    },
    { field: 'title', code: 'INVALID_LENGTH', params: { min: 1, max: 120 } },
    {
      field: 'visibility',
      code: 'INVALID_VALUE',
      params: { allowed: ['private', 'owners', 'occupants'] },
    },
    {
      field: 'expiresOn',
      code: 'INVALID_FORMAT',
      params: { format: 'YYYY-MM-DD' },
    },
  ],
};

export const UNIT_DOCUMENT_ROUTES: Row[] = [
  ...(['', '/staff'] as const).flatMap((side): Row[] => {
    const as = side ? 'manager' : 'owner';
    const denied = side ? 'owner' : 'guard';
    const unitNotFound = {
      params: (w: World) => ({ unitId: w.b.homeUnitId, id: w.bRegistrationId }),
      code: 'UNIT_NOT_FOUND',
    };
    return [
      {
        method: 'GET',
        path: `${side}/units/{unitId}/documents`,
        auth: 'tenant',
        as,
        denied,
        foreign: unitNotFound,
        invalid: 'none',
      },
      {
        method: 'GET',
        path: `${side}/units/{unitId}/documents/{id}`,
        auth: 'tenant',
        as,
        denied,
        foreign: side
          ? {
              params: (w: World) => ({
                unitId: w.a.homeUnitId,
                id: w.bRegistrationId,
              }),
              code: 'UNIT_DOCUMENT_NOT_FOUND',
            }
          : unitNotFound,
        invalid: 'none',
        noStore: true,
      },
      {
        method: 'POST',
        path: `${side}/units/{unitId}/documents`,
        auth: 'tenant',
        as,
        denied,
        foreign: {
          ...unitNotFound,
          body: () => ({
            fileId: '0192a5f0-1c2b-7d3e-8f40-0000000062a9',
            kind: 'manual',
            title: 'Manual',
            visibility: 'occupants',
          }),
        },
        invalid: NEW_DOCUMENT_INVALID,
      },
      {
        method: 'POST',
        path: `${side}/units/{unitId}/documents/{id}/delete`,
        auth: 'tenant',
        as,
        denied,
        foreign: side
          ? {
              params: (w: World) => ({
                unitId: w.a.homeUnitId,
                id: w.bRegistrationId,
              }),
              code: 'UNIT_DOCUMENT_NOT_FOUND',
            }
          : unitNotFound,
        invalid: 'none',
      },
    ];
  }),
];

// The compound's documents (ADR 0062).
export const COMPOUND_DOCUMENT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/compound-documents',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/compound-documents/versions',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { kind: 'rules' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'bylaws',
              'occupant_rights',
              'conduct_guide',
              'moving_guide',
              'saving_tips',
            ],
          },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/compound-documents/versions/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRegistrationId }),
      code: 'COMPOUND_DOCUMENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/compound-documents',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/compound-documents/versions',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: {
        kind: 'conduct_guide',
        titleEn: '',
        titleAr: 'لائحة',
        bodyEn: 'Body',
        bodyAr: 'نص',
        effectiveOn: '2026-02-30',
      },
      fields: [
        {
          field: 'titleEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
        {
          field: 'effectiveOn',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
      ],
    },
  },
];

// A unit's contracts and lease renewals (ADR 0062).
const UNKNOWN = '0192a5f0-1c2b-7d3e-8f40-0000000062c1';
export const CONTRACT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/me/contracts',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  ...(['', '/end-options'] as const).map((tail): Row => ({
    method: 'GET',
    path: `/units/{unitId}/contracts/{id}${tail}`,
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, id: UNKNOWN }),
      code: 'CONTRACT_NOT_FOUND',
    },
    invalid: 'none',
    ...(tail ? {} : { noStore: true }),
  })),
  {
    method: 'POST',
    path: '/units/{unitId}/contracts/{id}/renewal-requests',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    // The unit's lock comes first: another compound's unit is not found.
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, id: UNKNOWN }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/contract-renewals/{id}/withdraw',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      code: 'CONTRACT_RENEWAL_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/units/{unitId}/contracts',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/units/{unitId}/contracts/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, id: UNKNOWN }),
      code: 'CONTRACT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/units/{unitId}/contracts',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({
        kind: 'ownership',
        partyOccupancyIds: [UNKNOWN],
        signedOn: '2026-01-01',
        startsOn: '2026-01-01',
        fileId: UNKNOWN,
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: {
        kind: 'rent',
        partyOccupancyIds: [],
        // Shaped as days, and no days.
        signedOn: '2026-02-30',
        startsOn: '2026-04-31',
        endsOn: '2027-02-29',
        fileId: UNKNOWN,
      },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['lease', 'ownership'] },
        },
        {
          field: 'partyOccupancyIds',
          code: 'INVALID_LENGTH',
          params: { min: 1 },
        },
        {
          field: 'signedOn',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
        {
          field: 'startsOn',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
        {
          field: 'endsOn',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/contracts/{id}/void',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({ reasonCode: 'data_error' }),
      code: 'CONTRACT_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/contract-renewals',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/contract-renewals/{id}/decline',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({ reasonCode: 'other' }),
      code: 'CONTRACT_RENEWAL_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];

// Clearances and deposits (ADR 0062).
export const CLEARANCE_DEPOSIT_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/units/{unitId}/clearances',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/units/{unitId}/clearances',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/clearances/{id}/certificate',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'CLEARANCE_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/units/{unitId}/clearances',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/clearances/{id}/certificate',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'CLEARANCE_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/public/clearances/lookup',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: { code: 5, unitId: 'x' },
      fields: [
        { field: 'unitId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'code', code: 'INVALID_TYPE' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/me/deposits',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  ...(['refund-request', 'refund-request/withdraw'] as const).map(
    (tail): Row => ({
      method: 'POST',
      path: `/deposits/{id}/${tail}`,
      auth: 'tenant',
      as: 'owner',
      denied: 'guard',
      foreign: { params: () => ({ id: UNKNOWN }), code: 'DEPOSIT_NOT_FOUND' },
      invalid: 'none',
    }),
  ),
  {
    method: 'GET',
    path: '/staff/units/{unitId}/deposits',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/deposits',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: {
        occupancyId: 'x',
        kind: 'rent',
        amount: '10',
        receivedOn: '2026-02-30',
        method: 'cash',
      },
      fields: [
        { field: 'occupancyId', code: 'INVALID_UUID' },
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['finishing_works', 'move', 'maintenance_fund', 'other'],
          },
        },
        {
          field: 'receivedOn',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/deposits/{id}/settle',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({ refund: { amount: '10', channel: 'cash' } }),
      code: 'DEPOSIT_NOT_FOUND',
    },
    invalid: {
      body: { refund: { amount: '10', channel: 'card' } },
      fields: [
        {
          field: 'refund.channel',
          code: 'INVALID_VALUE',
          params: { allowed: ['cash', 'bank_transfer'] },
        },
      ],
    },
  },
];
