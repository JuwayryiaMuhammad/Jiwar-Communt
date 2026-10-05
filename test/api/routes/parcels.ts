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
