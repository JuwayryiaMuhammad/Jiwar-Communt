import type { Row } from '../registry';

const KINDS = ['pedestrian', 'vehicle', 'mixed'];

/** Gates (management) and the guard's shift (ADR 0028). */
export const GATE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/gates',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/gates',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { name: '', kind: 'door' },
      fields: [
        { field: 'name', code: 'INVALID_LENGTH', params: { min: 1, max: 80 } },
        { field: 'kind', code: 'INVALID_VALUE', params: { allowed: KINDS } },
      ],
    },
  },
  {
    method: 'PATCH',
    path: '/gates/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.b.gateId }),
      body: () => ({ kind: 'vehicle' }),
      code: 'GATE_NOT_FOUND',
    },
    invalid: {
      body: { status: 'closed' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['active', 'inactive'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/gate/gates',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/gate/shifts/start',
    auth: 'tenant',
    as: 'guard',
    denied: 'manager',
    foreign: {
      params: () => ({}),
      body: (w) => ({ gateId: w.b.gateId }),
      code: 'GATE_NOT_FOUND',
    },
    invalid: {
      body: { gateId: 'gate-1' },
      fields: [{ field: 'gateId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'POST',
    path: '/gate/shifts/end',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/gate/shifts/current',
    auth: 'tenant',
    as: 'guard',
    denied: 'family',
    foreign: 'none',
    invalid: 'none',
  },
];
