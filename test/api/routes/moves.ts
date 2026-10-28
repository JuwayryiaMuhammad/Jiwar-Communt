import type { Row } from '../registry';

/** Another compound's move, or none: the one not-found. */
const UNKNOWN = '0192a5f0-1c2b-7d3e-8f40-0000000063a1';

/** Moving in and out (ADR 0063): the resident's side, then the management's. */
export const MOVE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/moves',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/moves/move-out',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    // The unit's lock comes first: another compound's unit is not found.
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({ plannedOn: '2099-01-05' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { plannedOn: 'soon' },
      fields: [
        {
          field: 'plannedOn',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/units/{unitId}/moves/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, id: UNKNOWN }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/moves/{id}/steps',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, id: UNKNOWN }),
      body: () => ({ step: 'guide_read' }),
      code: 'MOVE_NOT_FOUND',
    },
    invalid: {
      body: { step: 'Guide Read' },
      fields: [
        {
          field: 'step',
          code: 'INVALID_FORMAT',
          params: { format: 'step key' },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/units/{unitId}/moves/{id}/cancel',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, id: UNKNOWN }),
      body: () => ({ reasonCode: 'plans_changed' }),
      code: 'MOVE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/moves',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'gone' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['planned', 'done', 'cancelled'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/moves/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'MOVE_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/units/{unitId}/moves',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      body: () => ({
        occupancyId: UNKNOWN,
        direction: 'out',
        plannedOn: '2099-01-05',
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { occupancyId: UNKNOWN, direction: 'up', plannedOn: '2099-01-05' },
      fields: [
        {
          field: 'direction',
          code: 'INVALID_VALUE',
          params: { allowed: ['in', 'out'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/moves/{id}/steps',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({ step: 'meters_read' }),
      code: 'MOVE_NOT_FOUND',
    },
    invalid: {
      body: { step: '' },
      fields: [
        {
          field: 'step',
          code: 'INVALID_FORMAT',
          params: { format: 'step key' },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/moves/{id}/done',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'MOVE_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/moves/{id}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({ reasonCode: 'other' }),
      code: 'MOVE_NOT_FOUND',
    },
    invalid: 'none',
  },
];
