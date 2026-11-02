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
  'purchase_request',
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

/** The board's authorizations for a waiver or a plan (ADR 0073). */
export const BOARD_AUTHORITY_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/finance/board-authorizations',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { type: 'major_contract' },
      fields: [
        {
          field: 'type',
          code: 'INVALID_VALUE',
          params: {
            allowed: ['waiver_above_limit', 'payment_plan_above_limit'],
          },
        },
      ],
    },
    noStore: true,
  },
];

/** Deputies (ADR 0073): either account reads and ends one; the manager names one. */
export const DEPUTY_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/deputies',
    auth: 'tenant',
    as: 'manager',
    denied: 'none',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/deputies',
    auth: 'tenant',
    as: 'manager',
    denied: 'supervisor',
    foreign: 'none',
    invalid: {
      body: {
        deputyAccountId: 'nope',
        permissions: [],
        endsAt: '2099-02-30T08:00:00Z',
      },
      fields: [
        { field: 'deputyAccountId', code: 'INVALID_UUID' },
        {
          field: 'permissions',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 50 },
        },
        { field: 'endsAt', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/deputies/{id}/end',
    auth: 'tenant',
    as: 'manager',
    denied: 'none',
    foreign: {
      params: () => ({ id: '0193b8a4-0000-7000-8000-000000000000' }),
      code: 'DEPUTY_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];
