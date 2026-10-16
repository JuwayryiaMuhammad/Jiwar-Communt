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
