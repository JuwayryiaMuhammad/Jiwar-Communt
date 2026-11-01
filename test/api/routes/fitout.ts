import type { Row } from '../registry';

/** Another compound's permit, or none: the one not-found. */
const UNKNOWN = '0192a5f0-1c2b-7d3e-8f40-0000000074d1';

/** A works permit's fit-out (ADR 0074). */
export const FITOUT_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/permits/{id}/fit-out',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'PERMIT_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/drawings',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({ fileId: UNKNOWN }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: {
      body: { fileId: 'x' },
      fields: [{ field: 'fileId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/drawings/{drawingId}/remove',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: () => ({ id: UNKNOWN, drawingId: UNKNOWN }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/debris-slots',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({
        day: '2099-01-05',
        window: { from: '10:00', to: '12:00' },
      }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: {
      body: { day: '2026-02-30', window: { from: '9', to: '12:00' } },
      fields: [
        {
          field: 'day',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
        { field: 'window.from', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/debris-slots/{slotId}/cancel',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: () => ({ id: UNKNOWN, slotId: UNKNOWN }),
      body: () => ({ reasonCode: 'other' }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'GET',
    path: '/staff/unit-permits/{id}/fit-out',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: { params: () => ({ id: UNKNOWN }), code: 'PERMIT_NOT_FOUND' },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/debris-slots',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({
        day: '2099-01-05',
        window: { from: '10:00', to: '12:00' },
      }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: {
      body: { day: '2026-02-30', window: { from: '9', to: '12:00' } },
      fields: [
        {
          field: 'day',
          code: 'INVALID_FORMAT',
          params: { format: 'YYYY-MM-DD' },
        },
        { field: 'window.from', code: 'INVALID_FORMAT' },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/debris-slots/{slotId}/cancel',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN, slotId: UNKNOWN }),
      body: () => ({ reasonCode: 'other' }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/debris-slots/{slotId}/done',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN, slotId: UNKNOWN }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/area-records',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({
        commonAreaId: UNKNOWN,
        phase: 'before',
        photoFileIds: [UNKNOWN],
      }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: {
      body: { commonAreaId: 'x', phase: 'during', photoFileIds: [] },
      fields: [
        { field: 'commonAreaId', code: 'INVALID_UUID' },
        {
          field: 'phase',
          code: 'INVALID_VALUE',
          params: { allowed: ['before', 'after'] },
        },
        { field: 'photoFileIds', code: 'INVALID_LENGTH', params: { min: 1 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/damage-claims',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN }),
      body: () => ({
        reasonCode: 'other',
        description: 'Broken tile',
        amount: '10',
        photoFileIds: [UNKNOWN],
      }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: {
      body: { description: 'Broken tile', amount: '10', photoFileIds: [] },
      fields: [
        { field: 'photoFileIds', code: 'INVALID_LENGTH', params: { min: 1 } },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/damage-claims/{claimId}/appeal-decision',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN, claimId: UNKNOWN }),
      body: () => ({ decision: 'upheld' }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: {
      body: { decision: 'maybe' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['upheld', 'accepted'] },
        },
      ],
    },
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/damage-claims/{claimId}/withdraw',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN, claimId: UNKNOWN }),
      body: () => ({ reasonCode: 'other' }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/staff/unit-permits/{id}/damage-claims/{claimId}/settle',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: () => ({ id: UNKNOWN, claimId: UNKNOWN }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: 'none',
    noStore: true,
  },
  {
    method: 'POST',
    path: '/permits/{id}/damage-claims/{claimId}/appeal',
    auth: 'tenant',
    as: 'owner',
    denied: 'guard',
    foreign: {
      params: () => ({ id: UNKNOWN, claimId: UNKNOWN }),
      body: () => ({ text: 'Not our works' }),
      code: 'PERMIT_NOT_FOUND',
    },
    invalid: {
      body: { text: 'Not our works', photoFileId: 'x' },
      fields: [{ field: 'photoFileId', code: 'INVALID_UUID' }],
    },
    noStore: true,
  },
];
