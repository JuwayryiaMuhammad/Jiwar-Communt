import type { Row } from '../registry';

const HOURS = { min: 1, max: 720 };

/**
 * Requests to the management (ADR 0039): topics, settings and office hours.
 * Every response of the phase is no-store.
 */
export const MANAGEMENT_SETUP_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/management/request-topics',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/request-topics',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        key: 'Parking!',
        nameAr: '',
        nameEn: 'Parking',
        targetResponseHours: 0,
      },
      fields: [
        { field: 'key', code: 'INVALID_FORMAT' },
        {
          field: 'nameAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 80 },
        },
        { field: 'targetResponseHours', code: 'INVALID_NUMBER', params: HOURS },
      ],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/management/request-topics/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: {
      params: (w) => ({ id: w.bManagementTopicId }),
      body: () => ({ active: false }),
      code: 'MANAGEMENT_TOPIC_NOT_FOUND',
    },
    invalid: {
      body: { active: 'no', targetResponseHours: 721 },
      fields: [
        { field: 'targetResponseHours', code: 'INVALID_NUMBER', params: HOURS },
        { field: 'active', code: 'INVALID_TYPE' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management-request-topics',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/request-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/management/request-settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { autoCloseDays: 0, appointmentSlotMinutes: 5 },
      fields: [
        {
          field: 'autoCloseDays',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 90 },
        },
        {
          field: 'appointmentSlotMinutes',
          code: 'INVALID_NUMBER',
          params: { min: 10, max: 240 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/office-hours',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/management/office-hours',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { windows: [{ weekday: 7, startMinute: 540, endMinute: 1441 }] },
      fields: [
        {
          field: 'windows.0.weekday',
          code: 'INVALID_NUMBER',
          params: { min: 0, max: 6 },
        },
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
