import type { Row } from '../registry';

/**
 * Maintenance analytics and cases (ADR 0081): sensitive tickets and the log
 * of their reads, the analytics' settings, repeat faults and the complaints
 * map, plan suggestions and community cases.
 */
export const MAINTENANCE_ANALYTICS_ROUTES: Row[] = [
  {
    method: 'PUT',
    path: '/maintenance/tickets/{id}/sensitivity',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bTicketId }),
      body: () => ({ sensitive: true, reasonCode: 'resident_privacy' }),
      code: 'TICKET_NOT_FOUND',
    },
    invalid: {
      body: { sensitive: 'yes', reasonCode: 1 },
      fields: [
        { field: 'sensitive', code: 'INVALID_TYPE' },
        { field: 'reasonCode', code: 'INVALID_TYPE' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/tickets/{id}/sensitive-reads',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: { params: (w) => ({ id: w.bTicketId }), code: 'TICKET_NOT_FOUND' },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/maintenance/settings/analytics',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'PATCH',
    path: '/maintenance/settings/analytics',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { caseMinTickets: 1, caseWindowDays: 181 },
      fields: [
        {
          field: 'caseMinTickets',
          code: 'INVALID_NUMBER',
          params: { min: 2, max: 20 },
        },
        {
          field: 'caseWindowDays',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 180 },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/recurrence',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: '2026-02-30', to: '2026-03-01', by: 'floor' },
      fields: [
        {
          field: 'by',
          code: 'INVALID_VALUE',
          params: { allowed: ['asset', 'unit', 'building', 'common_area'] },
        },
        { field: 'from', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/complaints-map',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { from: '2026-04-31', to: '2026-05-01', categoryId: 'x' },
      fields: [
        { field: 'from', code: 'INVALID_FORMAT' },
        { field: 'categoryId', code: 'INVALID_UUID' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/plan-suggestions',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: 'none',
    invalid: {
      query: { status: 'lost' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'accepted', 'dismissed'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/plan-suggestions/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'owner',
    foreign: {
      params: (w) => ({ id: w.bPlanSuggestionId }),
      code: 'PLAN_SUGGESTION_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/plan-suggestions/{id}/accept',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bPlanSuggestionId }),
      body: (w) => ({ planId: w.bPlanSuggestionId }),
      code: 'PLAN_SUGGESTION_NOT_FOUND',
    },
    invalid: {
      body: { planId: 'x' },
      fields: [{ field: 'planId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/plan-suggestions/{id}/dismiss',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bPlanSuggestionId }),
      body: () => ({ reasonCode: 'already_planned' }),
      code: 'PLAN_SUGGESTION_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/cases',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      query: { status: 'lost', buildingId: 'x' },
      fields: [
        {
          field: 'status',
          code: 'INVALID_VALUE',
          params: { allowed: ['open', 'resolved', 'dismissed'] },
        },
        { field: 'buildingId', code: 'INVALID_UUID' },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/cases/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bMaintenanceCaseId }),
      code: 'MAINTENANCE_CASE_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/cases/{id}/resolve',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bMaintenanceCaseId }),
      body: () => ({ reasonCode: 'fixed' }),
      code: 'MAINTENANCE_CASE_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'POST',
    path: '/maintenance/cases/{id}/dismiss',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bMaintenanceCaseId }),
      body: () => ({ reasonCode: 'not_related' }),
      code: 'MAINTENANCE_CASE_NOT_FOUND',
    },
    invalid: {
      body: { reasonCode: ['x'] },
      fields: [{ field: 'reasonCode', code: 'INVALID_TYPE' }],
    },
  },
];
