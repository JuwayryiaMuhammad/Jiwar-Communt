import type { Row } from '../registry';

const VALID_SCHEDULE = {
  days: [1],
  windows: [{ from: '06:00', to: '14:00' }],
};

/** The guards' roster (ADR 0050): the management's side and the guard's own. */
export const ROSTER_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/security/posts',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/guards',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/roster/templates',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        guardId: 'guard-1',
        schedule: VALID_SCHEDULE,
        effectiveFrom: '2026-1-1',
      },
      fields: [
        { field: 'guardId', code: 'INVALID_UUID' },
        { field: 'effectiveFrom', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/roster/templates',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { state: 'open' },
      fields: [{ field: 'state', code: 'INVALID_VALUE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/roster/templates/{id}/end',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRosterTemplateId }),
      code: 'ROSTER_TEMPLATE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/roster/slots',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        guardId: 'guard-1',
        startsAt: 'soon',
        endsAt: '2026-11-01T10:00:00Z',
      },
      fields: [
        { field: 'guardId', code: 'INVALID_UUID' },
        { field: 'startsAt', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/roster/slots',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { from: '2026-13-01' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/roster/slots/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRosterSlotId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'ROSTER_SLOT_NOT_FOUND',
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/attendance',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { guardId: 'guard-1' },
      fields: [{ field: 'guardId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/gate/roster',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      query: { to: 'tomorrow' },
      fields: [{ field: 'to', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/gate/roster/attendance',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      query: { from: 'today' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
];
