import type { Row } from '../registry';

/** The checkpoints a patrol scans (ADR 0052): the management's side. */
export const CHECKPOINT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/security/patrols/checkpoints',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'gone' },
      fields: [{ field: 'status', code: 'INVALID_VALUE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/patrols/checkpoints',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { gateId: 'gate-1', nameEn: 'Fence', nameAr: 'سور' },
      fields: [{ field: 'gateId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/security/patrols/checkpoints/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bCheckpointId }),
      body: () => ({ nameEn: 'Foreign' }),
      code: 'PATROL_CHECKPOINT_NOT_FOUND',
    },
    invalid: {
      body: { nameEn: 7 },
      fields: [{ field: 'nameEn', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/patrols/checkpoints/{id}/reissue',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bCheckpointId }),
      code: 'PATROL_CHECKPOINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/patrols/checkpoints/{id}/retire',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bCheckpointId }),
      code: 'PATROL_CHECKPOINT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

const SOME_ID = '0199c3d2-6f1a-7c3e-9a51-3b2f6e8d1c40';

/** The routes a patrol walks (ADR 0052): the management's side. */
export const ROUTE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/security/patrols/routes',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'gone' },
      fields: [{ field: 'status', code: 'INVALID_VALUE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/patrols/routes',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: {
        gateId: 'gate-1',
        nameEn: 'Round',
        nameAr: 'جولة',
        version: {
          checkpointIds: [SOME_ID],
          ordered: false,
          expectedMinutes: 30,
        },
      },
      fields: [{ field: 'gateId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/patrols/routes/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRouteId }),
      code: 'PATROL_ROUTE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/staff/security/patrols/routes/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRouteId }),
      body: () => ({ nameEn: 'Foreign' }),
      code: 'PATROL_ROUTE_NOT_FOUND',
    },
    invalid: {
      body: { nameEn: 7 },
      fields: [{ field: 'nameEn', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/patrols/routes/{id}/versions',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRouteId }),
      body: (w) => ({
        checkpointIds: [w.bCheckpointId],
        ordered: false,
        expectedMinutes: 30,
      }),
      code: 'PATROL_ROUTE_NOT_FOUND',
    },
    invalid: {
      body: { checkpointIds: ['point-1'], ordered: true, expectedMinutes: 30 },
      fields: [{ field: 'checkpointIds', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/patrols/routes/{id}/retire',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRouteId }),
      code: 'PATROL_ROUTE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/** A guard's patrols (ADR 0052), inside a shift. */
export const GUARD_PATROL_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/gate/patrols',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/gate/patrols/runs',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/gate/patrols/runs/{id}',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/patrols/runs/{id}/start',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/patrols/routes/{id}/start',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bRouteId }),
      code: 'PATROL_ROUTE_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/patrols/runs/{id}/scans',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      body: () => ({
        id: SOME_ID,
        method: 'qr',
        payload: 'JWK1.foreign',
        scannedAt: new Date().toISOString(),
      }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: {
      body: {
        id: 'scan-1',
        method: 'qr',
        payload: 'JWK1.x',
        scannedAt: '2026-11-01T08:00:00Z',
      },
      fields: [{ field: 'id', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/patrols/runs/{id}/notes',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      body: () => ({
        id: SOME_ID,
        scanId: SOME_ID,
        outcome: 'all_clear',
        notedAt: new Date().toISOString(),
      }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: {
      body: {
        id: SOME_ID,
        scanId: SOME_ID,
        outcome: 'fine',
        notedAt: '2026-11-01T08:00:00Z',
      },
      fields: [{ field: 'outcome', code: 'INVALID_VALUE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/patrols/runs/{id}/track',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      body: () => ({
        points: [{ recordedAt: new Date().toISOString(), lat: 30, lng: 31 }],
      }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: {
      body: { points: [] },
      fields: [
        {
          field: 'points',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 100 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/gate/patrols/runs/{id}/track',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/patrols/runs/{id}/end',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/** The runs as the management reads them (ADR 0052). */
export const STAFF_RUN_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/security/patrols/runs',
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
    method: 'GET',
    path: '/staff/security/patrols/runs/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/patrols/runs/{id}/track',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  // ADR 0056.
  {
    method: 'GET',
    path: '/staff/security/patrols/runs/{id}/geofence-exits',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/security/patrols/runs/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bRunId }),
      body: () => ({ reasonCode: 'other' }),
      code: 'PATROL_RUN_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 7 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
];

/** The patrol report (ADR 0052). */
export const PATROL_REPORT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/security/patrols/report',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { routeId: 'route-1' },
      fields: [{ field: 'routeId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
];
