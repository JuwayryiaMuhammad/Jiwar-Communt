import type { Row } from '../registry';

/** A guard's ID scan (ADR 0068): read once, never kept. */
export const ID_SCAN_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/id-scans',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      body: { imageFileId: 'nope' },
      fields: [{ field: 'imageFileId', code: 'INVALID_UUID' }],
    },
  },
];

/** A guard's face check against the blocklist's faces (ADR 0068). */
export const FACE_CHECK_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/face-checks',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      body: { photoFileId: 'nope' },
      fields: [{ field: 'photoFileId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'GET',
    path: '/gate/face-checks/{id}',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bFaceCheckId }),
      code: 'FACE_CHECK_NOT_FOUND',
    },
    invalid: 'none',
  },
];
