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
    path: '/staff/security/blocklist/{id}/matches',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bBlocklistEntryId }),
      code: 'BLOCKLIST_ENTRY_NOT_FOUND',
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
    path: '/gate/id-lookup',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { idNumber: 7 },
      fields: [{ field: 'idNumber', code: 'INVALID_TYPE' }],
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

/** Stop work on a works permit (ADR 0053). */
export const STOP_WORK_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/unit-permits/{id}/stop-work',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPermitId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({ reasonCode: 'safety_hazard' }),
    },
    invalid: {
      body: { reasonCode: 3 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/stop-work',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId }),
      code: 'PERMIT_NOT_FOUND',
      body: () => ({ reasonCode: 'safety_hazard' }),
    },
    invalid: {
      body: { reasonCode: 3 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/resume-work',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bPermitId }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/** Incidents (ADR 0053): the guard's side and the management's. */
export const INCIDENT_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/incidents',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: {
        type: 'riot',
        severity: 'low',
        unitCode: 'A1',
        occurredAt: '2026-10-01T10:00:00Z',
        description: 'x',
      },
      fields: [
        {
          field: 'type',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'injury',
              'near_miss',
              'hazard',
              'security_breach',
              'property_damage',
              'fire',
              'other',
            ],
          },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/gate/incidents',
    auth: 'tenant',
    as: 'guard',
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
    method: 'GET',
    path: '/gate/incidents/{id}',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bIncidentId }),
      code: 'INCIDENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/incidents/{id}/acknowledge',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bIncidentId }),
      code: 'INCIDENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/incidents',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        type: 'hazard',
        severity: 'apocalyptic',
        unitCode: 'A1',
        occurredAt: '2026-10-01T10:00:00Z',
        description: 'x',
      },
      fields: [
        {
          field: 'severity',
          code: 'INVALID_VALUE',
          params: { allowed: ['low', 'medium', 'high', 'critical'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/incidents',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'investigating', 'closed'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/incidents/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bIncidentId }),
      code: 'INCIDENT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/incidents/{id}/assign',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bIncidentId }),
      code: 'INCIDENT_NOT_FOUND',
      body: (w) => ({ investigatorId: w.a.ids.manager }),
    },
    invalid: {
      body: { investigatorId: 'someone' },
      fields: [{ field: 'investigatorId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/incidents/{id}/notes',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bIncidentId }),
      code: 'INCIDENT_NOT_FOUND',
      body: () => ({ body: 'A note' }),
    },
    invalid: {
      body: { body: '' },
      fields: [
        {
          field: 'body',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/incidents/{id}/acknowledge',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bIncidentId }),
      code: 'INCIDENT_NOT_FOUND',
      body: () => ({ role: 'reviewer' }),
    },
    invalid: {
      body: { role: 'judge' },
      fields: [
        {
          field: 'role',
          code: 'INVALID_VALUE',
          params: { allowed: ['author', 'reviewer'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/incidents/{id}/close',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bIncidentId }),
      code: 'INCIDENT_NOT_FOUND',
      body: () => ({ reasonCode: 'resolved', note: 'Done' }),
    },
    invalid: {
      body: { reasonCode: 'resolved' },
      fields: [{ field: 'note', code: 'FIELD_REQUIRED' }],
    },
    noStore: true,
  },
];
