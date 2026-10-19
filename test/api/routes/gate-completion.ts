import type { Row } from '../registry';

const ID = '00000000-0000-7000-8000-000000000000';

/** The gate's settings (ADR 0056). */
export const GATE_SETTINGS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/gate/settings',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/staff/gate/settings',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        exceptionAnswerMinutes: 0,
        exceptionEntryMinutes: 121,
        visitExpectedMinutes: 14,
      },
      fields: [
        {
          field: 'exceptionAnswerMinutes',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 60 },
        },
        {
          field: 'exceptionEntryMinutes',
          code: 'INVALID_NUMBER',
          params: { min: 5, max: 120 },
        },
        {
          field: 'visitExpectedMinutes',
          code: 'INVALID_NUMBER',
          params: { min: 15, max: 720 },
        },
      ],
    },
  },
];

/** Field exceptions: the guard asks, the on-duty management answers (ADR 0056). */
export const FIELD_EXCEPTION_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/field-exceptions',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        kind: 'worker_outside_hours',
        reasonCode: 'regular_visitor',
        worker: { type: 'worker_engagement', id: w.bEngagementId },
      }),
      code: 'ENGAGEMENT_NOT_FOUND',
    },
    invalid: {
      body: {
        kind: 'pizza',
        reasonCode: 'other',
        worker: { type: 'gardener', id: ID },
      },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: {
            allowed: [
              'worker_outside_hours',
              'visitor_without_pass',
              'unregistered_vehicle',
            ],
          },
        },
        {
          field: 'worker.type',
          code: 'INVALID_VALUE',
          params: { allowed: ['worker_engagement', 'permit_worker'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/gate/field-exceptions/{id}',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bFieldExceptionId }),
      code: 'GATE_EXCEPTION_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/gate/field-exceptions/{id}/withdraw',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bFieldExceptionId }),
      code: 'GATE_EXCEPTION_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/gate/field-exceptions',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'maybe' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['pending', 'decided', 'all'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/gate/field-exceptions/{id}',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFieldExceptionId }),
      code: 'GATE_EXCEPTION_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/gate/field-exceptions/{id}/decide',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bFieldExceptionId }),
      body: () => ({ decision: 'approve' }),
      code: 'GATE_EXCEPTION_NOT_FOUND',
    },
    invalid: {
      body: { decision: 'maybe' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['approve', 'reject'] },
        },
      ],
    },
  },
];

/** Service vehicles at the gate (ADR 0056). */
export const SERVICE_VEHICLE_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/service-vehicles',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        plate: 'FRGN 1',
        kind: 'delivery',
        company: 'Foreign Co',
        facilityId: w.bFacilityId,
      }),
      code: 'FACILITY_NOT_FOUND',
    },
    invalid: {
      body: { plate: 'ABC 1', kind: 'bus', company: '' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['tanker', 'waste', 'delivery', 'other'] },
        },
        {
          field: 'company',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/gate/service-vehicles/{id}/exit',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bServiceVehicleId }),
      code: 'SERVICE_VEHICLE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/gate/service-vehicles',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/gate/service-vehicles',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { from: 'yesterday' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
  },
];

/** A visitor's photo at entry, and an incident's evidence (ADR 0056). */
export const VISITOR_PHOTO_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/gate/entries/{id}/photo',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bEntryId }),
      code: 'ENTRY_PHOTO_NOT_FOUND',
    },
    invalid: 'none',
  },
  ...(['gate', 'staff'] as const).flatMap((side): Row[] => {
    const base =
      side === 'gate' ? '/gate/incidents' : '/staff/security/incidents';
    const persona = side === 'gate' ? 'guard' : 'manager';
    const denied = side === 'gate' ? 'manager' : 'guard';
    return [
      {
        method: 'POST',
        path: `${base}/{id}/evidence`,
        auth: 'tenant',
        noStore: true,
        as: persona,
        denied,
        foreign: {
          params: (w) => ({ id: w.bGateIncidentId }),
          body: () => ({ kind: 'visitor_photo', entryId: ID }),
          code: 'INCIDENT_NOT_FOUND',
        },
        invalid: {
          body: { kind: 'selfie', entryId: 'nope' },
          fields: [
            {
              field: 'kind',
              code: 'INVALID_VALUE',
              params: { allowed: ['visitor_photo'] },
            },
            { field: 'entryId', code: 'INVALID_UUID' },
          ],
        },
      },
      {
        method: 'GET',
        path: `${base}/{id}/evidence`,
        auth: 'tenant',
        noStore: true,
        as: persona,
        denied,
        foreign: {
          params: (w) => ({ id: w.bGateIncidentId }),
          code: 'INCIDENT_NOT_FOUND',
        },
        invalid: 'none',
      },
    ];
  }),
];

/** The gate directory (ADR 0056). */
export const GATE_DIRECTORY_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/gate/directory',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: 'none',
  },
];

/** Resident vehicles counted, and the gate's traffic (ADR 0056). */
export const TRAFFIC_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/vehicle-passages',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: () => ({}),
      body: (w) => ({ vehicleId: w.bVehicleId, direction: 'in' }),
      code: 'VEHICLE_NOT_FOUND',
    },
    invalid: {
      body: { vehicleId: 'nope', direction: 'sideways' },
      fields: [
        { field: 'vehicleId', code: 'INVALID_UUID' },
        {
          field: 'direction',
          code: 'INVALID_VALUE',
          params: { allowed: ['in', 'out'] },
        },
      ],
    },
  },
  ...['/staff/gate/reports/traffic', '/staff/gate/reports/traffic/export'].map(
    (path): Row => ({
      method: 'GET',
      path,
      auth: 'tenant',
      noStore: true,
      as: 'manager',
      denied: 'guard',
      foreign: 'none',
      invalid: {
        query: { from: 'last week' },
        fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
      },
    }),
  ),
];
