import type { Row } from '../registry';

const TYPES = ['car', 'motorcycle', 'van'];

/**
 * Vehicles (ADR 0045): a unit's vehicles for its people, and the staff's
 * approvals and settings. Every response of the phase is no-store.
 */
export const VEHICLE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/vehicles',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/vehicles',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
      body: () => ({
        plate: 'ABC 123',
        makeAndModel: 'Car',
        color: 'Red',
        type: 'car',
      }),
    },
    invalid: {
      body: {
        plate: 'ABC 1',
        makeAndModel: 'Car',
        color: 'Red',
        type: 'truck',
      },
      fields: [
        { field: 'type', code: 'INVALID_VALUE', params: { allowed: TYPES } },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/vehicles/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bVehicleId }),
      code: 'VEHICLE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/vehicles/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bVehicleId }),
      code: 'VEHICLE_NOT_FOUND',
      body: () => ({ color: 'Blue' }),
    },
    invalid: {
      body: { type: 'truck' },
      fields: [
        { field: 'type', code: 'INVALID_VALUE', params: { allowed: TYPES } },
      ],
    },
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/vehicles/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bVehicleId }),
      code: 'VEHICLE_NOT_FOUND',
    },
    invalid: {
      query: { reasonCode: 'stolen' },
      fields: [
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: {
            allowed: ['sold', 'no_longer_used', 'registered_in_error', 'other'],
          },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/vehicles',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'gone' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'pending',
              'active',
              'expires_soon',
              'expired',
              'rejected',
              'removed',
            ],
          },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/vehicles/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bVehicleId }),
      code: 'VEHICLE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/vehicles/{id}/approve',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bVehicleId }),
      code: 'VEHICLE_NOT_FOUND',
      body: () => ({
        version: 1,
        stickerNumber: 'S-FOREIGN',
        permitValidUntil: '2099-01-01',
      }),
    },
    invalid: {
      body: {
        version: 0,
        stickerNumber: 'S-1',
        permitValidUntil: '2027-13-01',
      },
      fields: [
        { field: 'permitValidUntil', code: 'INVALID_FORMAT' },
        { field: 'version', code: 'INVALID_NUMBER', params: { min: 1 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/vehicles/{id}/reject',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bVehicleId }),
      code: 'VEHICLE_NOT_FOUND',
      body: () => ({ version: 1, reasonCode: 'other' }),
    },
    invalid: {
      body: { version: 1 },
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/vehicles/{id}/renew',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bVehicleId }),
      code: 'VEHICLE_NOT_FOUND',
      body: () => ({ permitValidUntil: '2099-01-01' }),
    },
    invalid: {
      body: { permitValidUntil: 'soon' },
      fields: [{ field: 'permitValidUntil', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/vehicles/{id}/remove',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bVehicleId }),
      code: 'VEHICLE_NOT_FOUND',
      body: () => ({ reasonCode: 'other' }),
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/vehicle-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/vehicle-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { maxVehiclesPerUnit: 21 },
      fields: [
        {
          field: 'maxVehiclesPerUnit',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 20 },
        },
      ],
    },
    noStore: true,
  },
];
