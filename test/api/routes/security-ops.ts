import type { Row } from '../registry';

/** The lockdown (ADR 0053): the guard's side and the management's. */
export const LOCKDOWN_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/lockdowns',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { scope: 'all', reasonCode: 'drill', confirmation: 'yes' },
      fields: [
        {
          field: 'confirmation',
          code: 'INVALID_VALUE',
          params: { allowed: ['LOCKDOWN'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/gate/lockdowns/active',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/lockdowns/{id}/overrides',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bLockdownId }),
      code: 'LOCKDOWN_NOT_FOUND',
      body: () => ({ reasonCode: 'ambulance' }),
    },
    invalid: {
      body: { reasonCode: 'ambulance', emergencyId: 'nope' },
      fields: [{ field: 'emergencyId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/lockdowns',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'over' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['live', 'ended'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/lockdowns/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bLockdownId }),
      code: 'LOCKDOWN_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/lockdowns/{id}/end',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bLockdownId }),
      code: 'LOCKDOWN_NOT_FOUND',
      body: () => ({ reasonCode: 'threat_cleared' }),
    },
    invalid: {
      body: { note: '' },
      fields: [
        { field: 'reasonCode', code: 'FIELD_REQUIRED' },
        {
          field: 'note',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 500 },
        },
      ],
    },
    noStore: true,
  },
];

/** The blocklist and the watchlist (ADR 0053). */
export const BLOCKLIST_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/security/blocklist',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { kind: 'maybe' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['ban', 'watch'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/blocklist',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { kind: 'ban', subject: 'car', reasonCode: 'other' },
      fields: [
        {
          field: 'subject',
          code: 'INVALID_VALUE',
          params: { allowed: ['plate', 'person'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/blocklist/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBlocklistEntryId }),
      code: 'BLOCKLIST_ENTRY_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/security/blocklist/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBlocklistEntryId }),
      code: 'BLOCKLIST_ENTRY_NOT_FOUND',
      body: () => ({ kind: 'watch' }),
    },
    invalid: {
      body: { note: '' },
      fields: [
        {
          field: 'note',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 1000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/blocklist/{id}/lift',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBlocklistEntryId }),
      code: 'BLOCKLIST_ENTRY_NOT_FOUND',
      body: () => ({ reasonCode: 'resolved' }),
    },
    invalid: {
      body: {},
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/gate/blocklist',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
];
