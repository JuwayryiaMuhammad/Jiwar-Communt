import { at, day } from '../../setup/facilities';
import type { Row } from '../registry';

/**
 * Facilities (ADR 0044): the facilities residents see, and their set-up by
 * the staff. Every response of the phase is no-store.
 */
export const FACILITY_SETUP_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/facilities',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/facilities/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFacilityId }),
      code: 'FACILITY_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/facilities',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/facilities/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFacilityId }),
      code: 'FACILITY_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/facilities',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        mode: 'bookable',
        nameEn: 'Court',
        nameAr: 'ملعب',
        slotMinutes: 5,
        capacity: 1,
      },
      fields: [
        {
          field: 'slotMinutes',
          code: 'INVALID_NUMBER',
          params: { min: 15, max: 480 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/facilities/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFacilityId }),
      code: 'FACILITY_NOT_FOUND',
      body: () => ({ position: 1 }),
    },
    invalid: {
      body: { weeklyQuota: 21 },
      fields: [
        {
          field: 'weeklyQuota',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 20 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/facilities/{id}/hours',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFacilityId }),
      code: 'FACILITY_NOT_FOUND',
      body: () => ({ windows: [] }),
    },
    invalid: {
      body: { windows: [{ weekday: 7, startMinute: 540, endMinute: 600 }] },
      fields: [
        {
          field: 'windows.0.weekday',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 6 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/staff/facilities/{id}/peak-windows',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFacilityId }),
      code: 'FACILITY_NOT_FOUND',
      body: () => ({ windows: [] }),
    },
    invalid: {
      body: { windows: [{ weekday: 1, startMinute: 540, endMinute: 1441 }] },
      fields: [
        {
          field: 'windows.0.endMinute',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 1440 },
        },
      ],
    },
    noStore: true,
  },
];

/** A valid booking body of A's roomy facility. */
export const bookingBody = (facilityId: string) => ({
  facilityId,
  startsAt: at(day(9), 21).toISOString(),
});

/** Bookings (ADR 0044): slots, a unit's bookings, one booking. */
export const BOOKING_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/facilities/{id}/slots',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFacilityId }),
      code: 'FACILITY_NOT_FOUND',
    },
    invalid: {
      query: { date: '2031-13-01' },
      fields: [{ field: 'date', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/bookings',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
      body: (w) => bookingBody(w.aFacilityId),
    },
    invalid: {
      body: { facilityId: 'x', startsAt: '2031-01-01T10:00:00Z' },
      fields: [{ field: 'facilityId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/units/{unitId}/bookings',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.bUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { scope: 'soon' },
      fields: [{ field: 'scope', code: 'INVALID_VALUE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/bookings/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBookingId }),
      code: 'BOOKING_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/bookings/{id}/cancel',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBookingId }),
      code: 'BOOKING_NOT_FOUND',
      body: () => ({ reasonCode: 'no_longer_needed' }),
    },
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
];
