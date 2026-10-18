import { newId } from '../../../src/core/common/uuid';
import type { Row } from '../registry';

/** A child's exit control, the household's side (ADR 0054). */
export const CHILD_CONTROL_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/children',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/children/{memberId}/control',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, memberId: w.bMinorId }),
      code: 'UNIT_NOT_FOUND',
      body: () => ({ mayLeaveAlone: false, notifyPickups: true }),
    },
    invalid: {
      body: { mayLeaveAlone: 'yes', notifyPickups: true },
      fields: [{ field: 'mayLeaveAlone', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/units/{unitId}/children/{memberId}/control',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, memberId: w.bMinorId }),
      code: 'UNIT_NOT_FOUND',
      body: () => ({ notifyPickups: false }),
    },
    invalid: {
      body: { notifyPickups: 'no' },
      fields: [{ field: 'notifyPickups', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/children/{memberId}/control/off',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, memberId: w.bMinorId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/children/{memberId}/control/card',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, memberId: w.bMinorId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'PUT',
    path: '/units/{unitId}/children/{memberId}/control/photo',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, memberId: w.bMinorId }),
      code: 'UNIT_NOT_FOUND',
      body: () => ({ fileId: newId() }),
    },
    invalid: {
      body: { fileId: 'nope' },
      fields: [{ field: 'fileId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'DELETE',
    path: '/units/{unitId}/children/{memberId}/control/photo',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, memberId: w.bMinorId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
];

/** Who may collect a child (ADR 0054). */
export const CHILD_ESCORT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/units/{unitId}/children/{memberId}/control/escorts',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, memberId: w.bMinorId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/children/{memberId}/control/escorts',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId, memberId: w.bMinorId }),
      code: 'UNIT_NOT_FOUND',
      body: () => ({
        kind: 'outside',
        outside: { fullName: 'Foreign Escort', phone: '+201001234567' },
      }),
    },
    invalid: {
      body: { kind: 'friend' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['adult', 'worker', 'outside'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'PATCH',
    path: '/units/{unitId}/children/{memberId}/control/escorts/{id}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({
        unitId: w.b.homeUnitId,
        memberId: w.bMinorId,
        id: w.bEscortId,
      }),
      code: 'UNIT_NOT_FOUND',
      body: () => ({ validUntil: null }),
    },
    invalid: {
      body: { validUntil: '2026-13-01' },
      fields: [{ field: 'validUntil', code: 'INVALID_FORMAT' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/units/{unitId}/children/{memberId}/control/escorts/{id}/revoke',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({
        unitId: w.b.homeUnitId,
        memberId: w.bMinorId,
        id: w.bEscortId,
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/units/{unitId}/children/{memberId}/control/escorts/{id}/reissue',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({
        unitId: w.b.homeUnitId,
        memberId: w.bMinorId,
        id: w.bEscortId,
      }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/public/child-pickups/lookup',
    auth: 'public',
    denied: 'none',
    foreign: 'none',
    noStore: true,
    invalid: {
      body: { token: 5, unitId: 'x' },
      fields: [
        { field: 'unitId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'token', code: 'INVALID_TYPE' },
      ],
    },
  },
];

/** A child at the gate, and the records (ADR 0054). */
export const CHILD_GATE_ROUTES: Row[] = [
  {
    method: 'POST',
    path: '/gate/children/verify',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { card: 5 },
      fields: [{ field: 'card', code: 'INVALID_TYPE' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/gate/children/exits',
    auth: 'tenant',
    as: 'guard',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { card: 'JWC1.x', escort: { code: '123456', alone: true } },
      fields: [{ field: 'escort.code', code: 'FIELD_NOT_ALLOWED' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/units/{unitId}/children/pickups',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ unitId: w.b.homeUnitId }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      query: { memberId: 'x' },
      fields: [{ field: 'memberId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/child-alerts',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { limit: '0' },
      fields: [
        {
          field: 'limit',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 100 },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/security/child-alerts/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bAlertId }),
      code: 'CHILD_ALERT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
];

/** Children registered for an event for children (ADR 0054). */
export const CHILD_EVENT_ROUTES: Row[] = [
  {
    method: 'PUT',
    path: '/events/{id}/children/{memberId}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bEventId, memberId: w.bMinorId }),
      code: 'COMMUNITY_EVENT_NOT_FOUND',
      body: () => ({}),
    },
    invalid: {
      body: { unitId: 'x' },
      fields: [{ field: 'unitId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'DELETE',
    path: '/events/{id}/children/{memberId}',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bEventId, memberId: w.bMinorId }),
      code: 'COMMUNITY_EVENT_NOT_FOUND',
    },
    invalid: 'none',
  },
];
