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

const TYPES = ['question', 'general', 'appointment'];
const STATUSES = ['open', 'in_progress', 'answered', 'closed'];
const MODES = ['in_person', 'phone'];
const APPOINTMENT_STATUSES = [
  'requested',
  'proposed',
  'confirmed',
  'cancelled',
  'superseded',
];
const BODY = { min: 1, max: 4000 };
const LIMIT = { min: 1, max: 100 };
/** A body that passes validation, so the lookup is what fails. */
const SLOT = { startsAt: '2031-01-13T07:00:00.000Z', mode: 'in_person' };

const foreignRequest = (body?: object) => ({
  params: (w: { bManagementRequestId: string }) => ({
    id: w.bManagementRequestId,
  }),
  ...(body ? { body: () => body } : {}),
  code: 'MANAGEMENT_REQUEST_NOT_FOUND',
});

/** A resident's own requests (ADR 0039, `requests.create`). */
export const MANAGEMENT_RESIDENT_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/management-requests',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      body: { type: 'complaint', topicId: 'nope', body: '' },
      fields: [
        { field: 'type', code: 'INVALID_VALUE', params: { allowed: TYPES } },
        { field: 'topicId', code: 'INVALID_UUID' },
        { field: 'body', code: 'INVALID_LENGTH', params: BODY },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management-requests',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: STATUSES },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management-requests/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: foreignRequest(),
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management-requests/{id}/messages',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: foreignRequest(),
    invalid: {
      query: { limit: '0' },
      fields: [{ field: 'limit', code: 'INVALID_NUMBER', params: LIMIT }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management-requests/{id}/messages',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: foreignRequest({ body: 'Hello' }),
    invalid: {
      body: { body: '' },
      fields: [{ field: 'body', code: 'INVALID_LENGTH', params: BODY }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management-requests/{id}/withdraw',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: foreignRequest(),
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management-requests/{id}/reopen',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: foreignRequest({ body: 'Again' }),
    invalid: {
      body: { body: '' },
      fields: [{ field: 'body', code: 'INVALID_LENGTH', params: BODY }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management-requests/{id}/rating',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: foreignRequest({ rating: 3 }),
    invalid: {
      body: { rating: 9 },
      fields: [
        {
          field: 'rating',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 5 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management-appointment-slots',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { days: '99' },
      fields: [
        {
          field: 'days',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 31 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management-requests/{id}/appointment',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: foreignRequest(SLOT),
    invalid: {
      body: { startsAt: 'soon', mode: 'video' },
      fields: [
        { field: 'startsAt', code: 'INVALID_FORMAT' },
        { field: 'mode', code: 'INVALID_VALUE', params: { allowed: MODES } },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management-requests/{id}/appointment/accept',
    auth: 'tenant',
    as: 'owner',
    denied: 'technician',
    foreign: foreignRequest(),
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management-requests/{id}/appointment/cancel',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: foreignRequest({ reasonCode: 'other' }),
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/me/requests',
    auth: 'tenant',
    as: 'owner',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      query: { limit: '0' },
      fields: [{ field: 'limit', code: 'INVALID_NUMBER', params: LIMIT }],
    },
    noStore: true,
  },
];

/** The compound's requests, for the staff (`requests.handle`, `requests.manage`). */
export const MANAGEMENT_STAFF_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/management/requests',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { assignee: 'somebody', overdue: 'yes' },
      fields: [
        { field: 'assignee', code: 'INVALID_FORMAT' },
        {
          field: 'overdue',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/requests',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: 'none',
    invalid: {
      body: {
        type: 'general',
        topicId: '7b0e7a5e-1c1b-4d7f-9a53-1e6d6f3c2a10',
        body: 'Asked at the desk',
        authorAccountId: 'nope',
        reasonCode: 7,
      },
      fields: [
        { field: 'authorAccountId', code: 'INVALID_UUID' },
        { field: 'reasonCode', code: 'INVALID_TYPE' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/requests/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreignRequest(),
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/requests/{id}/assign',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: foreignRequest({ assigneeId: null }),
    invalid: {
      body: { assigneeId: 'nope' },
      fields: [{ field: 'assigneeId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/requests/{id}/messages',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreignRequest(),
    invalid: {
      query: { limit: '0' },
      fields: [{ field: 'limit', code: 'INVALID_NUMBER', params: LIMIT }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/requests/{id}/messages',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: foreignRequest({ body: 'Hello' }),
    invalid: {
      body: { body: 'A reply', internal: 'yes' },
      fields: [{ field: 'internal', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/requests/{id}/start',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreignRequest(),
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/requests/{id}/close',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: foreignRequest({ reasonCode: 'resolved' }),
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/request-assignees',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/units/{unitId}/request-authors',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/appointments',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'missed', from: 'yesterday' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: APPOINTMENT_STATUSES },
        },
        { field: 'from', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/appointment-slots',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: 'tomorrow' },
      fields: [
        {
          field: 'from',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/requests/{id}/appointment/confirm',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: foreignRequest(),
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/requests/{id}/appointment/propose',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: foreignRequest(SLOT),
    invalid: {
      body: { startsAt: 'soon', mode: 'video' },
      fields: [
        { field: 'startsAt', code: 'INVALID_FORMAT' },
        { field: 'mode', code: 'INVALID_VALUE', params: { allowed: MODES } },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/management/requests/{id}/appointment/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'family',
    foreign: foreignRequest({ reasonCode: 'other' }),
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/request-ratings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { limit: '0' },
      fields: [{ field: 'limit', code: 'INVALID_NUMBER', params: LIMIT }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/management/requests/{id}/rating',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: foreignRequest(),
    invalid: 'none',
    noStore: true,
  },
];
