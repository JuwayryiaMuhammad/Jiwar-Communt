import type { Row } from '../registry';

/** The control room (ADR 0068): the security supervisor's by default. */
export const CONTROL_ROOM_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/control-room/events',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'closed' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'acknowledged'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/control-room/events/{id}',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bControlRoomEventId }),
      code: 'CONTROL_ROOM_EVENT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/control-room/events/{id}/acknowledge',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bControlRoomEventId }),
      code: 'CONTROL_ROOM_EVENT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/control-room/posts',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
];

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
