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

/** Guard-down wearables (ADR 0068): the management's, and a guard's pairing. */
export const ALARM_DEVICE_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/staff/gate/alarm-devices',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { deviceRef: '', label: '' },
      fields: [
        {
          field: 'deviceRef',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
        { field: 'label', code: 'INVALID_LENGTH', params: { min: 1, max: 60 } },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/gate/alarm-devices',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['active', 'retired', 'all'] },
        },
      ],
    },
  },
  {
    method: 'PATCH',
    path: '/staff/gate/alarm-devices/{id}',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bAlarmDeviceId }),
      body: () => ({ label: 'Theirs' }),
      code: 'ALARM_DEVICE_NOT_FOUND',
    },
    invalid: {
      body: { label: '' },
      fields: [
        { field: 'label', code: 'INVALID_LENGTH', params: { min: 1, max: 60 } },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/gate/alarm-devices/{id}/retire',
    auth: 'tenant',
    as: 'supervisor',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bAlarmDeviceId }),
      body: () => ({ reasonCode: 'lost' }),
      code: 'ALARM_DEVICE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/gate/alarm-devices/pair',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: () => ({}),
      body: (w) => ({ deviceId: w.bAlarmDeviceId }),
      code: 'ALARM_DEVICE_NOT_FOUND',
    },
    invalid: {
      body: { deviceId: 'nope' },
      fields: [{ field: 'deviceId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'POST',
    path: '/gate/alarm-devices/unpair',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: 'none',
  },
];

/** A call from the gate (ADR 0068): the guard's side and the household's. */
export const GATE_CALL_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/calls',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: () => ({}),
      body: (w) => ({ unitId: w.b.homeUnitId, reasonCode: 'other' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { unitId: 'nope', reasonCode: 'other' },
      fields: [{ field: 'unitId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'GET',
    path: '/gate/calls/{id}',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bGateCallId }),
      code: 'GATE_CALL_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/gate/calls/{id}/join',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bGateCallId }),
      code: 'GATE_CALL_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/gate/calls/{id}/end',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: (w) => ({ id: w.bGateCallId }),
      code: 'GATE_CALL_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/me/gate-calls/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bGateCallId }),
      code: 'GATE_CALL_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/me/gate-calls/{id}/answer',
    auth: 'tenant',
    noStore: true,
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bGateCallId }),
      code: 'GATE_CALL_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/me/gate-calls/{id}/decline',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bGateCallId }),
      code: 'GATE_CALL_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/me/gate-calls/{id}/end',
    auth: 'tenant',
    as: 'owner',
    denied: 'none',
    foreign: {
      params: (w) => ({ id: w.bGateCallId }),
      code: 'GATE_CALL_NOT_FOUND',
    },
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
