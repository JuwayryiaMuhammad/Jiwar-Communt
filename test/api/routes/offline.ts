import type { Row } from '../registry';

/** Guard devices: a guard enrols, the management keeps them (ADR 0057). */
export const GATE_DEVICE_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/devices',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: {
      body: { id: 'nope', publicKey: 'short', proof: 'short' },
      fields: [
        { field: 'id', code: 'INVALID_UUID' },
        { field: 'publicKey', code: 'INVALID_FORMAT' },
        { field: 'proof', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/gate/devices',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['active', 'revoked', 'all'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/gate/devices/{id}',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bGateDeviceId }),
      code: 'GATE_DEVICE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/gate/devices/{id}/revoke',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bGateDeviceId }),
      body: () => ({ reasonCode: 'lost' }),
      code: 'GATE_DEVICE_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: 5 },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];

/** The gate bundle a device downloads, and the keys it is signed with (ADR 0057). */
export const GATE_BUNDLE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/gate/offline/keys',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/gate/offline/bundles',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        deviceId: w.bGateDeviceId,
        payload: 'e30',
        signature: 'A'.repeat(86),
      }),
      code: 'GATE_DEVICE_NOT_FOUND',
    },
    invalid: {
      body: { deviceId: 'nope', payload: 'not base64url!', signature: 'short' },
      fields: [
        { field: 'deviceId', code: 'INVALID_UUID' },
        { field: 'payload', code: 'INVALID_FORMAT' },
        { field: 'signature', code: 'INVALID_FORMAT' },
      ],
    },
  },
];

/** Offline uploads, and the management's flags (ADR 0057). */
export const OFFLINE_UPLOAD_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/offline/uploads',
    auth: 'tenant',
    noStore: true,
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: () => ({}),
      body: (w) => ({
        deviceId: w.bGateDeviceId,
        payload: 'e30',
        signature: 'A'.repeat(86),
      }),
      code: 'GATE_DEVICE_NOT_FOUND',
    },
    invalid: {
      body: { deviceId: 'nope', payload: 'not base64url!', signature: 'short' },
      fields: [
        { field: 'deviceId', code: 'INVALID_UUID' },
        { field: 'payload', code: 'INVALID_FORMAT' },
        { field: 'signature', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/gate/offline/flags',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'lost', class: 'urgent' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'cleared', 'reviewed', 'all'] },
        },
        {
          field: 'class',
          code: 'INVALID_VALUE',
          params: { allowed: ['security', 'manager', 'info'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/gate/offline/flags/{id}',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bOfflineFlagId }),
      code: 'GATE_OFFLINE_FLAG_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/gate/offline/flags/{id}/review',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bOfflineFlagId }),
      body: () => ({ reviewCode: 'confirmed' }),
      code: 'GATE_OFFLINE_FLAG_NOT_FOUND',
    },
    invalid: {
      body: { reviewCode: 5 },
      fields: [{ field: 'reviewCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/gate/offline/batches',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { status: 'quarantined' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['pending', 'reviewed', 'all'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/gate/offline/batches/{id}',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bOfflineBatchId }),
      code: 'GATE_OFFLINE_BATCH_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/gate/offline/batches/{id}/review',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bOfflineBatchId }),
      body: () => ({ decision: 'reject' }),
      code: 'GATE_OFFLINE_BATCH_NOT_FOUND',
    },
    invalid: {
      body: { decision: 'maybe' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['accept', 'reject'] },
        },
      ],
    },
  },
];
