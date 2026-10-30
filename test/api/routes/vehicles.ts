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
        permitValidUntil: '2027-02-29',
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
      body: { permitValidUntil: '2026-04-31' },
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

const soon = () => {
  const start = Math.ceil(Date.now() / 60_000) * 60_000 + 3_600_000;
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 3_600_000).toISOString(),
  };
};

/**
 * Parking (ADR 0045): a unit's slots and visitor bookings for its people,
 * the staff's slots, areas and day of bookings. All no-store.
 */
export const PARKING_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/parking',
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
    method: 'GET',
    path: '/units/{unitId}/visitor-parking-bookings',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { status: 'soon' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['upcoming', 'past'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/visitor-parking-bookings',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
      body: (w) => ({ areaId: w.aAreaId, visitorName: 'Guest', ...soon() }),
    },
    invalid: {
      body: {
        areaId: 'x',
        visitorName: 'Guest',
        startsAt: '2027-02-29T09:00:00Z',
        endsAt: '2099-02-30T08:00:00Z',
      },
      fields: [
        { field: 'areaId', code: 'INVALID_UUID' },
        { field: 'startsAt', code: 'INVALID_FORMAT' },
        { field: 'endsAt', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/units/{unitId}/visitor-parking-bookings/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId, id: w.bParkingBookingId }),
      code: 'VISITOR_PARKING_BOOKING_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/parking-slots',
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
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/parking-slots',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { unitCode: 'U-1', code: 'A1', place: ' ' },
      fields: [
        { field: 'place', code: 'INVALID_LENGTH', params: { min: 1, max: 80 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/parking-slots/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bSlotId }),
      code: 'PARKING_SLOT_NOT_FOUND',
      body: () => ({ place: 'Elsewhere' }),
    },
    invalid: {
      body: { code: 'X'.repeat(21) },
      fields: [
        { field: 'code', code: 'INVALID_LENGTH', params: { min: 1, max: 20 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/staff/parking-slots/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bSlotId }),
      code: 'PARKING_SLOT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/visitor-parking-areas',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/visitor-parking-areas',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { name: 'Gate 2', capacity: 501 },
      fields: [
        {
          field: 'capacity',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 500 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/visitor-parking-areas/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bAreaId }),
      code: 'VISITOR_PARKING_AREA_NOT_FOUND',
      body: () => ({ capacity: 3 }),
    },
    invalid: {
      body: { active: 'no' },
      fields: [{ field: 'active', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/visitor-parking-bookings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { day: '2026-02-30' },
      fields: [{ field: 'day', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/visitor-parking-bookings/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bParkingBookingId }),
      code: 'VISITOR_PARKING_BOOKING_NOT_FOUND',
      body: () => ({ reasonCode: 'other' }),
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
];

/** The guard's side (ADR 0045): `gate.operate`, inside an open shift. */
export const GATE_VEHICLE_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/plate-lookup',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { plate: '' },
      fields: [
        { field: 'plate', code: 'INVALID_LENGTH', params: { min: 1, max: 40 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/gate/visitor-parking',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
];

/** Fines (ADR 0045): a unit's for its people; issue and decide for the staff. */
export const FINE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/vehicle-fines',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { status: 'under_appeal' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['unpaid', 'paid', 'cancelled'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/vehicle-fines/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFineId }),
      code: 'VEHICLE_FINE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/vehicle-fines/{id}/appeal',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFineId }),
      code: 'VEHICLE_FINE_NOT_FOUND',
      body: () => ({ reason: 'Not mine' }),
    },
    invalid: {
      body: { reason: 7 },
      fields: [{ field: 'reason', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/vehicle-fines',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: {
        unitCode: 'U-1',
        plate: 'AB 1',
        reason: 'blocking',
        amount: '0',
        occurredOn: '2026-13-01',
      },
      fields: [
        { field: 'amount', code: 'INVALID_FORMAT' },
        { field: 'occurredOn', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/vehicle-fines',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'owed' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['unpaid', 'under_appeal', 'paid', 'cancelled'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/vehicle-fines/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFineId }),
      code: 'VEHICLE_FINE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/vehicle-fines/{id}/decide-appeal',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFineId }),
      code: 'VEHICLE_FINE_NOT_FOUND',
      body: () => ({ decision: 'upheld' }),
    },
    invalid: {
      body: { decision: 'maybe' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['upheld', 'cancelled'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/vehicle-fines/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFineId }),
      code: 'VEHICLE_FINE_NOT_FOUND',
      body: () => ({ reasonCode: 'other' }),
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
];

/** A fine's payments at the office (ADR 0045): `fines.billing`. */
export const FINE_PAYMENT_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/staff/vehicle-fines/{id}/payments',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFineId }),
      code: 'VEHICLE_FINE_NOT_FOUND',
      body: () => ({
        amount: '300',
        receiptNumber: 'R-FOREIGN',
        paidOn: '2026-10-15',
      }),
    },
    invalid: {
      body: { amount: '300', receiptNumber: 'no spaces', paidOn: '2026-02-30' },
      fields: [
        { field: 'receiptNumber', code: 'INVALID_FORMAT' },
        { field: 'paidOn', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/vehicle-fine-payments/{id}/reverse',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFinePaymentId }),
      code: 'FINE_PAYMENT_NOT_FOUND',
      body: () => ({ reasonCode: 'other' }),
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
];

/** Parking reports (ADR 0045): residents report; security works the queue. */
export const PARKING_REPORT_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/parking-reports',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { plate: 'AB 1', location: 5 },
      fields: [{ field: 'location', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/parking-reports',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
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
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/parking-reports',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'pending' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'closed', 'converted'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/parking-reports/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bParkingReportId }),
      code: 'PARKING_REPORT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/parking-reports/{id}/close',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bParkingReportId }),
      code: 'PARKING_REPORT_NOT_FOUND',
      body: () => ({ reasonCode: 'resolved' }),
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/parking-reports/{id}/convert',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bParkingReportId }),
      code: 'PARKING_REPORT_NOT_FOUND',
      body: () => ({
        unitCode: 'NONE',
        plate: 'AB 1',
        reason: 'blocking',
        amount: '100',
        occurredOn: '2026-10-15',
      }),
    },
    invalid: {
      body: {
        unitCode: 'U-1',
        plate: 'AB 1',
        reason: 'blocking',
        amount: 'free',
        occurredOn: '2027-02-29',
      },
      fields: [
        { field: 'amount', code: 'INVALID_FORMAT' },
        { field: 'occurredOn', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
];
