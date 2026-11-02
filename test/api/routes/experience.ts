import type { Row } from '../registry';

const SIGNALS = [
  'repeated_low_ratings',
  'reopened_tickets',
  'repeated_complaints',
];
const OUTCOMES = [
  'resolved',
  'compensated',
  'no_action_needed',
  'resident_unreachable',
  'resident_declined',
];
const FAILURES = [
  'service_outage',
  'maintenance_delay',
  'facility_closure',
  'other',
];

/**
 * Experience and recovery (ADR 0082): the signal thresholds and the
 * signals, the cases, the compensations and their rules, the service
 * promises and the ratings report, for `experience.manage`; a
 * compensation's decision for `experience.compensate`.
 */
export const EXPERIENCE_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/experience/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/staff/experience/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      body: { items: [{ code: 'repeated_low_ratings', count: 1 }] },
      fields: [
        {
          field: 'items.0.count',
          code: 'INVALID_NUMBER',
          params: { min: 2, max: 20 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/experience/signals',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { code: 'x' },
      fields: [
        { field: 'code', code: 'INVALID_VALUE', params: { allowed: SIGNALS } },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/experience/cases',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { status: 'x' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'closed'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/experience/cases',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: () => ({}),
      body: (w) => ({ unitId: w.bUnitId, kind: 'recovery' }),
      code: 'UNIT_NOT_FOUND',
    },
    invalid: {
      body: { unitId: 'x', kind: 'x' },
      fields: [
        { field: 'unitId', code: 'INVALID_UUID' },
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['follow_up', 'recovery'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/experience/cases/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bExperienceCaseId }),
      code: 'EXPERIENCE_CASE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/experience/cases/{id}/assign',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bExperienceCaseId }),
      body: (w) => ({ ownerId: w.a.ids.manager }),
      code: 'EXPERIENCE_CASE_NOT_FOUND',
    },
    invalid: {
      body: { ownerId: 'x' },
      fields: [{ field: 'ownerId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'POST',
    path: '/staff/experience/cases/{id}/close',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bExperienceCaseId }),
      body: () => ({ outcome: 'resolved' }),
      code: 'EXPERIENCE_CASE_NOT_FOUND',
    },
    invalid: {
      body: { outcome: 'x' },
      fields: [
        {
          field: 'outcome',
          code: 'INVALID_VALUE',
          params: { allowed: OUTCOMES },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/experience/cases/{id}/compensations',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bExperienceCaseId }),
      body: () => ({ kind: 'apology', failureCode: 'other' }),
      code: 'EXPERIENCE_CASE_NOT_FOUND',
    },
    invalid: {
      body: { kind: 'x', failureCode: 'y' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['credit', 'apology', 'redo', 'priority'] },
        },
        {
          field: 'failureCode',
          code: 'INVALID_VALUE',
          params: { allowed: FAILURES },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/experience/compensations',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { status: 'x' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['proposed', 'approved', 'rejected'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/experience/compensations/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bCompensationId }),
      code: 'COMPENSATION_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/experience/compensations/{id}/decide',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bCompensationId }),
      body: () => ({ decision: 'approve' }),
      code: 'COMPENSATION_NOT_FOUND',
    },
    invalid: {
      body: { decision: 'x' },
      fields: [
        {
          field: 'decision',
          code: 'INVALID_VALUE',
          params: { allowed: ['approve', 'reject'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/experience/compensation-rules',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PUT',
    path: '/staff/experience/compensation-rules',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { items: [{ failureCode: 5, kind: 'apology' }] },
      fields: [{ field: 'items.0.failureCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/experience/promises',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { active: 'x' },
      fields: [
        {
          field: 'active',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/experience/promises',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { titleEn: '', titleAr: '' },
      fields: [
        {
          field: 'titleEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
        {
          field: 'titleAr',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
      ],
    },
  },
  {
    method: 'PATCH',
    path: '/staff/experience/promises/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bServicePromiseId }),
      body: () => ({ active: false }),
      code: 'SERVICE_PROMISE_NOT_FOUND',
    },
    invalid: {
      body: { titleEn: '' },
      fields: [
        {
          field: 'titleEn',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/experience/promises/report',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: '2026-02-30' },
      fields: [{ field: 'from', code: 'INVALID_FORMAT' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/experience/ratings-report',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { to: '2027-02-29' },
      fields: [{ field: 'to', code: 'INVALID_FORMAT' }],
    },
  },
];
