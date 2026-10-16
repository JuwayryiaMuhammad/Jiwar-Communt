import type { Row } from '../registry';

/** The compound's permit rules (ADR 0049). */
export const PERMIT_SETTINGS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/community/permit-rules',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/permit-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/permit-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { workDays: [], workHours: { from: '9', to: '17:00' } },
      fields: [
        {
          field: 'workDays',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 7 },
        },
        { field: 'workHours.from', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
];

const worksBody = {
  workType: 'renovation',
  startsOn: '2099-01-05',
  endsOn: '2099-01-06',
  dailyHours: { from: '09:00', to: '17:00' },
  contractorCompany: 'Matrix Builders',
  description: 'Matrix works',
};

/** A unit's permits, the household's side (ADR 0049). */
export const PERMIT_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/units/{unitId}/permits/works',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
      body: () => worksBody,
    },
    invalid: {
      body: { ...worksBody, workType: 'demolition', startsOn: 'tomorrow' },
      fields: [
        {
          field: 'workType',
          code: 'INVALID_VALUE',
          params: { allowed: ['renovation', 'finishing'] },
        },
        { field: 'startsOn', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/permits/moves',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
      body: () => ({
        date: '2099-01-05',
        window: { from: '10:00', to: '12:00' },
        truckPlate: 'ABC 123',
        itemsDescription: 'Sofas',
      }),
    },
    invalid: {
      body: {
        date: '2099-01-05',
        window: { from: '10:00', to: '25:00' },
        truckPlate: 7,
        itemsDescription: '',
      },
      fields: [
        { field: 'window.to', code: 'INVALID_FORMAT' },
        { field: 'truckPlate', code: 'INVALID_TYPE' },
        {
          field: 'itemsDescription',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/permits/material-exits',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
      body: () => ({
        validFrom: '2099-01-05',
        validUntil: '2099-01-06',
        items: [{ name: 'Tiles', quantity: 3 }],
      }),
    },
    invalid: {
      body: {
        validFrom: '2099-01-05',
        validUntil: '2099-01-06',
        items: [{ name: 'Tiles', quantity: 1.5 }],
      },
      fields: [
        {
          field: 'items.0.quantity',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 9999 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/permits/events',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
      body: () => ({
        startsAt: '2099-01-05T16:00:00.000Z',
        endsAt: '2099-01-05T20:00:00.000Z',
        guests: [{ fullName: 'Matrix Guest' }],
      }),
    },
    invalid: {
      body: {
        startsAt: 'tonight',
        endsAt: '2099-01-05T20:00:00.000Z',
        guests: [],
      },
      fields: [
        { field: 'startsAt', code: 'INVALID_FORMAT' },
        {
          field: 'guests',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 150 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/units/{unitId}/permits',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { kind: 'party' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['works', 'move', 'material_exit', 'event'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/permits/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/cancel',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({}),
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/workers',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({
        fullName: 'Matrix Worker',
        photoFileId: '0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e5f',
        idType: 'national_id',
        idLast4: '1234',
      }),
    },
    invalid: {
      body: {
        fullName: 'A',
        photoFileId: 'face',
        idType: 'card',
        idLast4: '1',
      },
      fields: [
        {
          field: 'fullName',
          code: 'INVALID_LENGTH',
          params: { min: 2, max: 120 },
        },
        { field: 'photoFileId', code: 'INVALID_UUID' },
        {
          field: 'idType',
          code: 'INVALID_VALUE',
          params: { allowed: ['national_id', 'passport'] },
        },
        { field: 'idLast4', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/guests',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitEventId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({ guests: [{ fullName: 'Matrix Guest' }] }),
    },
    invalid: {
      body: { guests: [{ fullName: 'M' }] },
      fields: [
        {
          field: 'guests.0.fullName',
          code: 'INVALID_LENGTH',
          params: { min: 2, max: 120 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/guests/{guestId}/remove',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitEventId, guestId: w.bPermitGuestId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({}),
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/workers/{workerId}/remove',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId, workerId: w.bPermitWorkerId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({}),
    },
    invalid: 'none',
    noStore: true,
  },
];

/** The units' permits, the management's side (ADR 0049). */
export const STAFF_PERMIT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/unit-permits',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { live: 'sometimes' },
      fields: [{ field: 'live', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/unit-permits/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/approve',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({}),
    },
    invalid: {
      body: { note: '' },
      fields: [
        { field: 'note', code: 'INVALID_LENGTH', params: { min: 1, max: 500 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/reject',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({ reasonCode: 'other' }),
    },
    invalid: {
      body: { reasonCode: 3 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/revoke',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({ reasonCode: 'other' }),
    },
    invalid: {
      body: { reasonCode: 3 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/workers/{workerId}/remove',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId, workerId: w.bPermitWorkerId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({ reasonCode: 'other' }),
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
];
