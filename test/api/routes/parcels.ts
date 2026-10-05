import { newId } from '../../../src/core/common/uuid';
import type { Row } from '../registry';

/** The status filter's closed list (ADR 0035). */
export const PARCEL_STATUSES = ['held', 'handed_over', 'rejected', 'returned'];

/** The guard's parcels (ADR 0035): `parcels.handle`, inside a shift. */
export const GATE_PARCELS_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/parcels',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    // The unit is looked up before the photo: another compound's code is just
    // an unknown unit.
    foreign: {
      params: () => ({}),
      body: (w) => ({
        unitCode: w.bUnitCode,
        carrier: 'dhl',
        pieces: 1,
        photoFileId: newId(),
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { unitCode: '', carrier: 'pigeon', pieces: 0, labelName: '' },
      fields: [
        {
          field: 'unitCode',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 64 },
        },
        {
          field: 'carrier',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'aramex',
              'dhl',
              'fedex',
              'ups',
              'bosta',
              'mylerz',
              'egypt_post',
              'amazon',
              'noon',
              'jumia',
              'talabat',
              'other',
            ],
          },
        },
        {
          field: 'pieces',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 20 },
        },
        { field: 'photoFileId', code: 'FIELD_REQUIRED' },
        {
          field: 'labelName',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/gate/parcels',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: PARCEL_STATUSES },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/gate/parcels/{id}',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bParcelId }),
      code: 'PARCEL_NOT_FOUND',
    },
    invalid: 'none',
    // The photos, as short-lived URLs.
    noStore: true,
  },
];

/** The hand-over and the return, on the guard's own routes (ADR 0035). */
export const HANDOVER_PARCELS_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/parcels/lookup',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      body: { code: '' },
      fields: [
        { field: 'code', code: 'INVALID_LENGTH', params: { min: 1, max: 32 } },
      ],
    },
    // A delegate's name.
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/parcels/{id}/handover',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bParcelId }),
      body: () => ({ code: '123456' }),
      code: 'PARCEL_NOT_FOUND',
    },
    invalid: {
      body: { code: '', qr: '', residentQr: '', photoFileId: 'not-a-uuid' },
      // The class's own fields come before the ones it inherits.
      fields: [
        {
          field: 'residentQr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 256 },
        },
        { field: 'photoFileId', code: 'INVALID_UUID' },
        { field: 'code', code: 'INVALID_LENGTH', params: { min: 1, max: 32 } },
        { field: 'qr', code: 'INVALID_LENGTH', params: { min: 1, max: 256 } },
      ],
    },
    // A delegate's name.
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/parcels/{id}/return',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bParcelId }),
      code: 'PARCEL_NOT_FOUND',
    },
    invalid: 'none',
  },
];

/** The managers' parcels and the holding periods (ADR 0035): `parcels.manage`. */
export const MANAGER_PARCELS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/parcels',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    // The class's own field is reported before the ones it inherits.
    invalid: {
      query: { status: 'lost', carrier: 'pigeon' },
      fields: [
        {
          field: 'carrier',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'aramex',
              'dhl',
              'fedex',
              'ups',
              'bosta',
              'mylerz',
              'egypt_post',
              'amazon',
              'noon',
              'jumia',
              'talabat',
              'other',
            ],
          },
        },
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: PARCEL_STATUSES },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/parcels/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bParcelId }),
      code: 'PARCEL_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/parcel-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/parcel-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { parcelReminderDays: 0, parcelManagerDays: 1.5 },
      fields: [
        {
          field: 'parcelReminderDays',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 30 },
        },
        {
          field: 'parcelManagerDays',
          code: 'INVALID_NUMBER',
          params: { min: 2, max: 90 },
        },
      ],
    },
  },
];

/** A resident's parcels (ADR 0035): the capability `parcels` decides, no permission. */
export const RESIDENT_PARCELS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/me/parcels',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: PARCEL_STATUSES },
        },
      ],
    },
    // The code, the label and the photos.
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/parcels/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bParcelId }),
      code: 'PARCEL_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/me/parcels/{id}/reject',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bParcelId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'PARCEL_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 'because' },
      fields: [
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: { allowed: ['not_ours', 'not_expected', 'other'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/me/parcels/{id}/delegate',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bParcelId }),
      body: () => ({ name: 'Karim' }),
      code: 'PARCEL_NOT_FOUND',
    },
    invalid: {
      body: { name: '' },
      fields: [
        { field: 'name', code: 'INVALID_LENGTH', params: { min: 1, max: 80 } },
      ],
    },
    // The delegate's code, shown to the unit.
    noStore: true,
  },
  {
    method: 'POST',
    path: '/me/parcels/{id}/delegate/revoke',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bParcelId }),
      code: 'PARCEL_NOT_FOUND',
    },
    invalid: 'none',
  },
];
