import { REPORT_KEYS } from '../../../src/core/reports/report-registry';
import type { Row } from '../registry';

/**
 * The reports platform (ADR 0086): the curated reports, their schedules
 * and runs, the compound's export, and the capital plan to the board.
 */
export const REPORTS_ROUTES: Row[] = [
  {
    method: 'GET',
    path: '/staff/reports',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/reports/view',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { report: 'everything' },
      fields: [
        {
          field: 'report',
          code: 'INVALID_VALUE',
          params: { allowed: [...REPORT_KEYS] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/reports/export',
    noStore: true,
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { report: 'maintenance_spend', format: 'doc' },
      fields: [
        {
          field: 'format',
          code: 'INVALID_VALUE',
          params: { allowed: ['pdf', 'xlsx', 'csv'] },
        },
      ],
    },
  },
  {
    method: 'GET',
    path: '/staff/report-schedules',
    auth: 'tenant',
    as: 'manager',
    denied: 'supervisor',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/report-schedules',
    auth: 'tenant',
    as: 'manager',
    denied: 'supervisor',
    foreign: 'none',
    invalid: {
      body: { reportKey: 'everything', cadence: 'hourly', format: 'doc' },
      fields: [
        {
          field: 'reportKey',
          code: 'INVALID_VALUE',
          params: { allowed: [...REPORT_KEYS] },
        },
        {
          field: 'cadence',
          code: 'INVALID_VALUE',
          params: { allowed: ['daily', 'weekly', 'monthly'] },
        },
        {
          field: 'format',
          code: 'INVALID_VALUE',
          params: { allowed: ['pdf', 'xlsx', 'csv'] },
        },
      ],
    },
  },
  {
    method: 'PATCH',
    path: '/staff/report-schedules/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'supervisor',
    foreign: {
      params: (w) => ({ id: w.bReportScheduleId }),
      body: () => ({ active: false }),
      code: 'REPORT_SCHEDULE_NOT_FOUND',
    },
    invalid: {
      body: { active: 'no' },
      fields: [{ field: 'active', code: 'INVALID_TYPE' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/report-runs',
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: 'none',
    invalid: {
      query: { scheduleId: 'x' },
      fields: [{ field: 'scheduleId', code: 'INVALID_UUID' }],
    },
  },
  {
    method: 'GET',
    path: '/staff/report-runs/{id}/download',
    noStore: true,
    auth: 'tenant',
    as: 'manager',
    denied: 'guard',
    foreign: {
      params: (w) => ({ id: w.bReportRunId }),
      code: 'REPORT_RUN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/staff/compound-exports',
    auth: 'tenant',
    as: 'manager',
    denied: 'supervisor',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/compound-exports',
    auth: 'tenant',
    as: 'manager',
    denied: 'supervisor',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/staff/compound-exports/{id}/download',
    noStore: true,
    auth: 'tenant',
    as: 'manager',
    denied: 'supervisor',
    foreign: {
      params: (w) => ({ id: w.bCompoundExportId }),
      code: 'COMPOUND_EXPORT_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'GET',
    path: '/maintenance/capital-plans',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/capital-plans',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: 'none',
    invalid: {
      body: { year: 1999 },
      fields: [
        { field: 'year', code: 'INVALID_NUMBER', params: { min: 2000 } },
      ],
    },
  },
  {
    method: 'GET',
    path: '/maintenance/capital-plans/{id}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bCapitalPlanId }),
      code: 'CAPITAL_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
  {
    method: 'POST',
    path: '/maintenance/capital-plans/{id}/lines',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bCapitalPlanId }),
      body: () => ({ description: 'A new pump', amount: '800.00' }),
      code: 'CAPITAL_PLAN_NOT_FOUND',
    },
    invalid: {
      body: { description: '', amount: '0' },
      fields: [
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 200 },
        },
        { field: 'amount', code: 'INVALID_FORMAT' },
      ],
    },
  },
  {
    method: 'DELETE',
    path: '/maintenance/capital-plans/{id}/lines/{lineId}',
    auth: 'tenant',
    as: 'manager',
    denied: 'technician',
    foreign: {
      params: (w) => ({ id: w.bCapitalPlanId, lineId: w.bCapitalPlanLineId }),
      code: 'CAPITAL_PLAN_NOT_FOUND',
    },
    invalid: 'none',
  },
];
