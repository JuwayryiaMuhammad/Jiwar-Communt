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
