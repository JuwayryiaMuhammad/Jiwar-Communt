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
