import type { Row } from '../registry';

/**
 * The operations dashboard (ADR 0079): the cards, needs you now, the
 * buildings, the brief's times and the briefs; service pressure; and the
 * gate log's export. A technician holds none of their permissions by
 * default; a guard holds no gate_log.search.
 */
export const STAFF_DASHBOARD_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/dashboard',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/dashboard/needs-you',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/dashboard/buildings',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/dashboard/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/staff/dashboard/settings',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { briefAt: '25:00', reviewAt: 7 },
      fields: [
        { field: 'briefAt', code: 'INVALID_FORMAT' },
        { field: 'reviewAt', code: 'INVALID_TYPE' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/briefs',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { kind: 'weekly' },
      fields: [
        {
          field: 'kind',
          code: 'INVALID_VALUE',
          params: { allowed: ['brief', 'review'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/briefs/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bStaffBriefId }),
      code: 'STAFF_BRIEF_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/maintenance/service-pressure',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/service-pressure',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { openPerTechnician: 0 },
      fields: [
        {
          field: 'openPerTechnician',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 100 },
        },
      ],
    },
  },
  {
    method: 'POST',
    path: '/staff/gate/log-search/export',
    auth: 'tenant',
    noStore: true,
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      body: { from: '2027-02-29', to: '2026-02-30' },
      fields: [
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'to', code: 'INVALID_FORMAT' },
      ],
    },
  },
];
