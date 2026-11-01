import type { Row } from '../registry';

const INBOX_TYPES = [
  'registration',
  'identity_change',
  'worker_engagement',
  'vehicle',
  'booking',
  'unit_permit',
  'work_permit',
  'field_exception',
  'plan_request',
  'invoice_dispute',
  'decision_appeal',
  'management_request',
];

/**
 * The staff inbox (ADR 0073): the queue, its count, the bulk approval and
 * the due times. A technician holds no `inbox.read` by default.
 */
export const STAFF_INBOX_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/inbox',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { type: 'parcel' },
      fields: [
        {
          field: 'type',
          code: 'INVALID_VALUE',
          params: { allowed: INBOX_TYPES },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/inbox/count',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/inbox/bulk-approve',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { items: [{ type: 'unit_permit', id: 'nope' }] },
      fields: [{ field: 'items.0.id', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/inbox/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/inbox/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { items: [{ type: 'vehicle', dueHours: 0 }] },
      fields: [
        {
          field: 'items.0.dueHours',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 720 },
        },
      ],
    },
    noStore: true,
  },
];
