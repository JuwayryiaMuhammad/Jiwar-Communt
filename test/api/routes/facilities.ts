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
