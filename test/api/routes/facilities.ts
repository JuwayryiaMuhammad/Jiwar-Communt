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

/** The staff's bookings (ADR 0044): the list and queue, a day, decisions. */
export const STAFF_BOOKING_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/bookings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'waiting' },
      fields: [{ field: 'status', code: 'INVALID_VALUE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/bookings/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bBookingId }),
      code: 'BOOKING_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/bookings/{id}/approve',
    auth: 'tenant',
    as: 'manager',
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
    path: '/staff/bookings/{id}/reject',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBookingId }),
      code: 'BOOKING_NOT_FOUND',
      body: () => ({ reasonCode: 'other' }),
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/bookings/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBookingId }),
      code: 'BOOKING_NOT_FOUND',
      body: () => ({ reasonCode: 'other' }),
    },
    invalid: {
      body: { reasonCode: ['other'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/facilities/{id}/day',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFacilityId }),
      code: 'FACILITY_NOT_FOUND',
    },
    invalid: {
      query: { date: 'today' },
      fields: [{ field: 'date', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
];

/** Closures (ADR 0044). */
export const CLOSURE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/facilities/{id}/closures',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFacilityId }),
      code: 'FACILITY_NOT_FOUND',
    },
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
    path: '/staff/facilities/{id}/closures',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFacilityId }),
      code: 'FACILITY_NOT_FOUND',
      body: () => ({
        startsAt: at(day(30), 10).toISOString(),
        endsAt: at(day(30), 11).toISOString(),
        reasonCode: 'other',
      }),
    },
    invalid: {
      body: {
        startsAt: 'soon',
        endsAt: at(day(30), 11).toISOString(),
        reasonCode: 'other',
      },
      fields: [{ field: 'startsAt', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/facility-closures/{id}/lift',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bClosureId }),
      code: 'FACILITY_CLOSURE_NOT_FOUND',
      body: () => ({ reasonCode: 'other' }),
    },
    invalid: {
      body: { reasonCode: 1 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
];

/** No-shows, suspensions and the compound's settings (ADR 0044). */
export const SUSPENSION_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/staff/bookings/{id}/no-show',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBookingId }),
      code: 'BOOKING_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/units/{unitId}/booking-standing',
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
    path: '/staff/booking-suspensions',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { inForce: 'yes' },
      fields: [
        {
          field: 'inForce',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/booking-suspensions/{id}/lift',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bSuspensionId }),
      code: 'BOOKING_SUSPENSION_NOT_FOUND',
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
    path: '/staff/facility-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/facility-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { suspensionDays: 91 },
      fields: [
        {
          field: 'suspensionDays',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 90 },
        },
      ],
    },
    noStore: true,
  },
];
