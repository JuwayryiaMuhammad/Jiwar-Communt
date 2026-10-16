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
